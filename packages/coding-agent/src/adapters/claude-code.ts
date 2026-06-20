import { readdirSync, readFileSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CanUseTool,
  ModelInfo,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  getSessionMessages,
  listSessions,
  query,
  getSessionInfo as sdkGetSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "@band-app/logger";
import type { ClaudeCodeConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import { computeCost } from "../pricing.js";
import { readSkillsFromDir } from "../skills.js";
import type {
  AgentMode,
  AgentModel,
  CliInvocation,
  CodingAgent,
  GetSessionMessagesOptions,
  RunSessionOptions,
  SessionInfo,
  SessionListItem,
  SessionMessageItem,
  SessionUsageSnapshot,
  SessionUsageTurn,
  SkillInfo,
  UserInputRequest,
} from "../types.js";

const log = createLogger("coding-agent:claude-code");

/**
 * Read the most recently modified plan file from the workspace.
 *
 * Claude Code writes plans into `<workspaceDir>/.claude/plans/`.
 */
function readLatestPlanFile(workspaceDir: string): string | undefined {
  const plansDirs = [join(workspaceDir, ".claude", "plans")];

  let newest: { path: string; mtime: number } | undefined;
  for (const dir of plansDirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const fullPath = join(dir, f);
        const mtime = statSync(fullPath).mtimeMs;
        if (!newest || mtime > newest.mtime) {
          newest = { path: fullPath, mtime };
        }
      }
    } catch {
      // Directory may not exist — skip.
    }
  }

  if (!newest) return undefined;
  try {
    return readFileSync(newest.path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Build a human-readable display title for a Claude Code tool call.
 *
 * Picks the most recognisable argument from the tool input so the UI can
 * show what the tool is doing at a glance without parsing raw JSON.
 */
function formatToolTitle(toolName: string, input: Record<string, unknown>): string {
  const arg =
    (input.command as string | undefined) ??
    (input.pattern as string | undefined) ??
    (input.query as string | undefined) ??
    (input.file_path as string | undefined) ??
    (input.url as string | undefined) ??
    (input.content as string | undefined) ??
    (input.description as string | undefined);
  if (typeof arg === "string") {
    const summary = arg.length > 80 ? `${arg.slice(0, 80)}...` : arg;
    return `${toolName}(${summary})`;
  }
  return toolName;
}

function formatUserAnswer(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([question, answer]) => `${question}: ${answer}`);
  return `The user selected:\n${lines.join("\n")}`;
}

// Mirrors the Claude Code SDK's project-dir encoder: replace any
// non-alphanumeric byte with `-`. Long paths (>200) get a hash suffix,
// which we don't replicate — callers fall back to firstPrompt when the
// computed path doesn't resolve.
function encodeProjectDir(absDir: string): string {
  return absDir.replace(/[^a-zA-Z0-9]/g, "-");
}

const SESSION_TAIL_BYTES = 64 * 1024;

interface CumulativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Per-session cumulative usage counters, persisted across `runSession`
 * invocations so `totalProcessedTokens` is monotonic across a continuing
 * conversation. Module-scoped (lives for the lifetime of the process); not
 * durable across server restarts.
 *
 * Bounded by `MAX_CUMULATIVE_SESSIONS` via simple insertion-order LRU eviction
 * to prevent unbounded growth in long-running servers.
 */
const cumulativeUsageBySession = new Map<string, CumulativeUsage>();
const MAX_CUMULATIVE_SESSIONS = 500;

/** Set into a bounded LRU map. JS Map preserves insertion order, so deleting
 * the first key drops the oldest. Re-inserting an existing key bumps it to
 * MRU. */
function lruSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// Read the most recent `last-prompt` record from a session JSONL file by
// scanning the last 64 KB. The CLI's /resume picker uses this latest
// prompt as the session title, so we surface the same string here.
//
// Async: synchronous fs calls would block the event loop; with N sessions
// the cumulative latency is multiplied. Callers (see `listSessions`) run
// these in parallel via `Promise.all`.
async function readSessionLastPrompt(
  workspaceDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const file = join(configDir, "projects", encodeProjectDir(workspaceDir), `${sessionId}.jsonl`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const { size } = await stat(file);
    if (size === 0) return undefined;
    const readSize = Math.min(size, SESSION_TAIL_BYTES);
    const buf = Buffer.alloc(readSize);
    handle = await open(file, "r");
    await handle.read(buf, 0, readSize, size - readSize);
    let text = buf.toString("utf8");
    // Drop the partial first line when we tailed the file.
    if (readSize < size) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"last-prompt"')) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === "last-prompt" && typeof record.lastPrompt === "string") {
          const trimmed = record.lastPrompt.trim();
          if (trimmed) return trimmed;
        }
      } catch {
        // Malformed line — keep scanning.
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }
}

export class ClaudeCodeAdapter implements CodingAgent {
  readonly name = "Claude Code";
  readonly supportedFeatures = {
    costTracking: true,
    sessionListing: true,
  } as const;

  onUserInputNeeded?: (request: UserInputRequest) => Promise<Record<string, string>>;

  private readonly workspaceDir: string;
  private readonly model: string | undefined;
  private readonly executablePath: string | undefined;
  private readonly additionalDirectories: string[] | undefined;
  /** See `claudeCodeConfigSchema.options.partialMessages`. */
  private readonly partialMessages: boolean;
  private activeConversation: ReturnType<typeof query> | null = null;

  constructor(config: ClaudeCodeConfig) {
    this.workspaceDir = config.workspaceDir;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath;
    this.additionalDirectories = config.additionalDirectories;
    this.partialMessages = config.options.partialMessages ?? false;
  }

  abort(): void {
    if (this.activeConversation) {
      log.info("aborting active conversation");
      this.activeConversation.close();
      this.activeConversation = null;
    }
  }

  async *runSession(
    prompt: string,
    sessionId?: string,
    options?: RunSessionOptions,
  ): AsyncGenerator<AgentEvent> {
    const env = { ...process.env };
    env.CLAUDECODE = undefined;
    env.CLAUDE_CODE_ENTRYPOINT = undefined;
    env.ANTHROPIC_CUSTOM_HEADERS = undefined;

    const effectiveModel = options?.model ?? this.model;

    log.info(
      {
        prompt: prompt.slice(0, 100),
        sessionId,
        model: effectiveModel,
        cwd: this.workspaceDir,
        claudeCodePath: this.executablePath || "(default)",
      },
      "runSession starting",
    );

    const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (!INTERACTIVE_TOOLS.has(toolName) || !this.onUserInputNeeded) {
        return { behavior: "allow", updatedInput: input };
      }

      const approvalId = options.toolUseID;
      log.info({ toolName, approvalId, toolUseID: options.toolUseID }, `${toolName} intercepted`);

      // ExitPlanMode input is {} — the plan content lives in a file written
      // by a preceding Write tool call. Read it and inject into the input so
      // the UI can render a plan preview.
      let enrichedInput = input as Record<string, unknown>;
      if (toolName === "ExitPlanMode") {
        const planContent = readLatestPlanFile(this.workspaceDir);
        if (planContent) {
          enrichedInput = { ...enrichedInput, plan: planContent };
        }
      }

      const answers = await this.onUserInputNeeded({
        approvalId,
        toolCallId: options.toolUseID,
        toolName,
        input: enrichedInput,
      });

      return { behavior: "deny", message: formatUserAnswer(answers) };
    };

    const permissionMode = options?.mode === "plan" ? ("plan" as const) : undefined;

    const conversation = query({
      prompt,
      options: {
        cwd: this.workspaceDir,
        model: effectiveModel,
        // No `maxTurns` — the Claude Agent SDK treats `undefined` as "no cap",
        // which matches Band's contract that the agent runs until it stops on
        // its own (model decides it's done, user aborts, or the SDK errors).
        resume: sessionId,
        canUseTool,
        env,
        additionalDirectories: this.additionalDirectories,
        pathToClaudeCodeExecutable: this.executablePath,
        settingSources: ["user", "project"],
        permissionMode,
        // Stream raw API events (`stream_event` messages wrapping
        // BetaRawMessageStreamEvent) alongside the canonical `assistant`
        // messages. Costs nothing extra — same API call, same tokens — and
        // lets the adapter forward `content_block_delta`/`text_delta` deltas
        // to the chat UI so bubbles type in token-by-token. The eventual
        // `assistant` message still arrives and remains the canonical truth;
        // the adapter dedupes via state.streamedTextBlocks.
        //
        // Gated behind a Settings toggle (off by default). Wired through:
        // SettingsPage → settings.json → agent-pool.getAgentConfig →
        // ClaudeCodeConfig.options.partialMessages → here.
        // See docs/experiments/partial-messages.md.
        includePartialMessages: this.partialMessages,
        stderr: (data) => log.warn({ data }, "claude-code stderr"),
      },
    });

    this.activeConversation = conversation;
    log.info("query() called, waiting for messages...");

    // Note: model-list caching used to live here (lazy, per-adapter-instance).
    // It now lives in `~/.band/settings.json` via `ModelRefreshService` —
    // refreshed explicitly from the Settings UI's "Refresh models" button
    // and fire-and-forget at server boot. See `refreshModels()` below.

    const state: ProcessedState = {
      assistantContentIndex: 0,
      toolNames: new Map(),
      hasEmittedTextSinceLastUser: false,
      streamedTextBlocks: new Set(),
      currentStreamBlockType: null,
    };

    // Cumulative session totals — persisted in `cumulativeUsageBySession`
    // keyed by sessionId so they survive `runSession` boundaries. New sessions
    // start at zero; resumed sessions pick up where the prior run left off.
    // This makes `totalProcessedTokens` truly monotonic across the whole
    // session and lets the task-runner monotonic guard rehydrate correctly.
    let currentSessionId = sessionId ?? "";
    const initialCumulative = currentSessionId
      ? cumulativeUsageBySession.get(currentSessionId)
      : undefined;
    let cumulativeInput = initialCumulative?.input ?? 0;
    let cumulativeOutput = initialCumulative?.output ?? 0;
    let cumulativeCacheRead = initialCumulative?.cacheRead ?? 0;
    let cumulativeCacheCreation = initialCumulative?.cacheCreation ?? 0;

    const persistCumulative = () => {
      if (!currentSessionId) return;
      lruSet(
        cumulativeUsageBySession,
        currentSessionId,
        {
          input: cumulativeInput,
          output: cumulativeOutput,
          cacheRead: cumulativeCacheRead,
          cacheCreation: cumulativeCacheCreation,
        },
        MAX_CUMULATIVE_SESSIONS,
      );
    };

    // Migrate stored cumulative under a newly-resolved sessionId. Called when
    // the SDK reports a session_id different from the one we initialised
    // with — typically the first `system.init` for a brand-new session.
    const adoptSessionId = (newSid: string) => {
      if (!newSid || newSid === currentSessionId) return;
      const prevStored = currentSessionId
        ? cumulativeUsageBySession.get(currentSessionId)
        : undefined;
      if (prevStored) {
        lruSet(cumulativeUsageBySession, newSid, prevStored, MAX_CUMULATIVE_SESSIONS);
        cumulativeUsageBySession.delete(currentSessionId);
      }
      currentSessionId = newSid;
      persistCumulative();
    };

    // Most recent canonical context snapshot from `getContextUsage()`.
    // Reused on the terminal `result` event so the final usage payload
    // reports the same window size the UI just rendered, instead of the
    // accumulated-across-API-calls number SDK puts on `result.usage`.
    let lastKnownContext: { contextTokens: number; maxContextTokens?: number } | undefined;

    try {
      for await (const message of conversation) {
        log.debug(
          {
            messageType: message.type,
            subtype: "subtype" in message ? message.subtype : undefined,
          },
          "sdk message",
        );

        // Adopt SDK-reported sessionId as soon as it's known so cumulatives
        // get persisted under the right key. Applies to brand-new sessions
        // (no `sessionId` param) and to any rare ID changes.
        const rawSid = (message as { session_id?: string | number | null }).session_id;
        if (rawSid != null) {
          adoptSessionId(String(rawSid));
        }

        // Handle the terminal `result` event's usage *before* delegating to
        // the mapper so the usage event lands ahead of any text-delta /
        // session-result the mapper emits for the same message. SDK's
        // `result.usage` is the accumulated total for this turn — drive
        // `totalProcessedTokens` from it; carry context-size from the most
        // recent `getContextUsage()` call so the meter doesn't briefly
        // jump to the inflated accumulated number.
        if (message.type === "result") {
          const resultUsage = (
            message as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            }
          ).usage;
          if (resultUsage) {
            const inputTokens = resultUsage.input_tokens ?? 0;
            const outputTokens = resultUsage.output_tokens ?? 0;
            const cacheReadTokens = resultUsage.cache_read_input_tokens ?? 0;
            const cacheCreationTokens = resultUsage.cache_creation_input_tokens ?? 0;
            cumulativeInput += inputTokens;
            cumulativeOutput += outputTokens;
            cumulativeCacheRead += cacheReadTokens;
            cumulativeCacheCreation += cacheCreationTokens;
            persistCumulative();

            // If no prior main-thread assistant message ran getContextUsage()
            // (e.g. tool-only turn or early termination), fetch a snapshot now
            // so the terminal usage event still carries an accurate context
            // size instead of forcing the UI onto the per-call summation
            // fallback (which under-counts: it omits system prompt, MCP
            // tools, and memory-file overhead).
            if (!lastKnownContext) {
              try {
                const ctx = await conversation.getContextUsage();
                lastKnownContext = {
                  contextTokens: ctx.totalTokens,
                  maxContextTokens: ctx.maxTokens,
                };
              } catch (err) {
                log.warn({ err }, "getContextUsage failed on result; emitting without snapshot");
              }
            }

            yield {
              type: "usage",
              provider: "claude",
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
              contextTokens: lastKnownContext?.contextTokens,
              maxContextTokens: lastKnownContext?.maxContextTokens,
              totalProcessedTokens:
                cumulativeInput + cumulativeOutput + cumulativeCacheRead + cumulativeCacheCreation,
            };
          }
        }

        yield* mapClaudeCodeEvent(message, state);

        // After each main-thread assistant message, ask the SDK for the
        // canonical context-window breakdown (same number Claude Code's
        // `/context` HUD displays). It includes system prompt, MCP tools,
        // memory files, and message history overhead — far more accurate
        // than summing per-call API usage. Skip subagent messages and
        // non-assistant messages. On failure, log and skip — falling back
        // to per-message summation drifts upward across multi-tool turns
        // and is worse than no update.
        if (
          message.type === "assistant" &&
          (message as { parent_tool_use_id?: string | null }).parent_tool_use_id == null
        ) {
          try {
            const ctx = await conversation.getContextUsage();
            lastKnownContext = {
              contextTokens: ctx.totalTokens,
              maxContextTokens: ctx.maxTokens,
            };
            // Mid-turn emission ticks the context meter without inflating the
            // tooltip's per-field counters: input/output/cache reflect the
            // last *completed* turn's cumulative totals (frozen between
            // result events), while contextTokens is a live SDK snapshot.
            // Surfacing `ctx.apiUsage` here would show single-API-call
            // values that look nonsensical next to a 50k-token context.
            yield {
              type: "usage",
              provider: "claude",
              inputTokens: cumulativeInput,
              outputTokens: cumulativeOutput,
              cacheReadTokens: cumulativeCacheRead,
              cacheCreationTokens: cumulativeCacheCreation,
              contextTokens: ctx.totalTokens,
              maxContextTokens: ctx.maxTokens,
              totalProcessedTokens:
                cumulativeInput + cumulativeOutput + cumulativeCacheRead + cumulativeCacheCreation,
            };
          } catch (err) {
            log.warn({ err }, "getContextUsage failed; skipping usage emission");
          }
        }
      }
      log.info("conversation generator done");
    } catch (err) {
      log.error({ err }, "conversation error");
      throw err;
    } finally {
      this.activeConversation = null;
      log.info("closing conversation");
      conversation.close();
    }
  }

  async listSessions(dir: string): Promise<SessionListItem[]> {
    log.info({ dir }, "listSessions");
    const sessions = await listSessions({ dir });
    const filtered = sessions.filter((s) => s.cwd === dir);
    // Fan out the per-session JSONL tail reads. Sequential fs calls
    // dominate workspace-switch latency when there are many sessions.
    const lastPrompts = await Promise.all(
      filtered.map((s) => readSessionLastPrompt(dir, s.sessionId)),
    );
    return filtered.map((s, i) => mapSessionInfo(s, lastPrompts[i]));
  }

  async getSessionInfo(sessionId: string, dir: string): Promise<SessionInfo | undefined> {
    // SDK's getSessionInfo reads only the single session file — much
    // cheaper than listSessions which walks the entire project dir.
    const info = await sdkGetSessionInfo(sessionId, { dir });
    if (!info) return undefined;
    const lastPrompt = await readSessionLastPrompt(dir, sessionId);
    const summary =
      info.customTitle ?? lastPrompt ?? info.summary ?? info.firstPrompt ?? "Untitled session";
    return {
      sessionId: info.sessionId,
      summary,
      lastModified: info.lastModified,
    };
  }

  async getLatestSession(dir: string): Promise<SessionInfo | undefined> {
    // mtime-sorted readdir of the project directory + a single
    // getSessionInfo on the newest file. Matches the fallback used by
    // the chat pane when no activeSessionId is persisted yet.
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const projectDir = join(configDir, "projects", encodeProjectDir(dir));
    let entries: string[];
    try {
      entries = readdirSync(projectDir);
    } catch {
      return undefined;
    }
    let newest: { sessionId: string; mtime: number } | undefined;
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const mtime = statSync(join(projectDir, name)).mtimeMs;
        if (!newest || mtime > newest.mtime) {
          newest = { sessionId: name.slice(0, -".jsonl".length), mtime };
        }
      } catch {
        // unreadable entry — skip
      }
    }
    if (!newest) return undefined;
    return this.getSessionInfo(newest.sessionId, dir);
  }

  async getSessionMessages(
    sessionId: string,
    dir: string,
    options?: GetSessionMessagesOptions,
  ): Promise<{ messages: SessionMessageItem[]; hasMore: boolean; firstOffset: number }> {
    log.info({ sessionId, dir, ...options }, "getSessionMessages");

    if (options?.tail !== undefined) {
      // Tail mode: SDK reads the whole file regardless (parent-chain
      // reconstruction requires it). We slice the last `tail + 1` from
      // the SDK's filtered list and use the +1 to set hasMore.
      const raw = await getSessionMessages(sessionId, { dir });
      const filtered = raw.filter(
        (m): m is SessionMessage & { type: "user" | "assistant" } =>
          m.type === "user" || m.type === "assistant",
      );
      const tail = Math.max(0, options.tail);
      const probedStart = Math.max(0, filtered.length - tail - 1);
      const probed = filtered.slice(probedStart);
      const hasMore = probed.length > tail;
      const slice = hasMore ? probed.slice(1) : probed;
      const firstOffset = probedStart + (hasMore ? 1 : 0);
      return {
        messages: slice.map(mapSessionMessage),
        hasMore,
        firstOffset,
      };
    }

    // Offset/limit mode: ask the SDK for one extra so an extra-row in
    // the response signals hasMore without a separate count. The SDK
    // still parses the whole file, but the returned array is bounded
    // and the per-message conversion cost stays in the slice.
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;
    const sdkLimit = limit !== undefined ? Math.max(0, limit) + 1 : undefined;
    const raw = await getSessionMessages(sessionId, { dir, offset, limit: sdkLimit });
    const filtered = raw.filter(
      (m): m is SessionMessage & { type: "user" | "assistant" } =>
        m.type === "user" || m.type === "assistant",
    );
    const hasMore = limit !== undefined && filtered.length > limit;
    const slice = hasMore ? filtered.slice(0, limit) : filtered;
    return {
      messages: slice.map(mapSessionMessage),
      hasMore,
      firstOffset: offset,
    };
  }

  /**
   * Read per-turn token + USD cost for a single session from
   * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
   *
   * **What's in the file.** Claude Code's session JSONL does NOT contain
   * `result` events with `total_cost_usd` — that field is computed by
   * the SDK at query time and isn't persisted. The file does contain one
   * `assistant` event per API round-trip, each with `message.usage.*`
   * (input/output/cache tokens) and `message.model` for the per-call
   * model id. One assistant event = one row in our `usage_events`
   * (consistent with how Codex and OpenCode count "turns").
   *
   * **Cost.** Computed from `pricing.ts` ratecard × per-message tokens.
   * Anthropic's API doesn't surface a separate cost field, and the SDK
   * doesn't write one to disk, so the ratecard is the only path for
   * historical sessions. Live Band-driven sessions still see live
   * `data-result` chat-view events with the SDK's `total_cost_usd`,
   * but that's a UI nicety, not the storage path.
   *
   * Returns `null` when the session isn't found — the scanner skips it
   * silently. Throws on permission errors etc. so the caller can log.
   */
  async getSessionUsage(sessionId: string, dir: string): Promise<SessionUsageSnapshot | null> {
    let raw: SessionMessage[];
    try {
      raw = await getSessionMessages(sessionId, { dir });
    } catch (err) {
      // The SDK throws ENOENT-style errors when the session file is
      // missing. Treat that as "nothing to scan" rather than propagating
      // up — a workspace can list a sessionId then have its file pruned
      // by Claude between the listing and the read.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT") || msg.toLowerCase().includes("not found")) {
        return null;
      }
      throw err;
    }
    if (raw.length === 0) return null;

    const turns: SessionUsageTurn[] = [];
    let turnIndex = 0;
    let startedAt = Number.POSITIVE_INFINITY;
    let updatedAt = 0;
    let modelFallback = "";

    for (const m of raw) {
      // `timestamp` in the JSONL is an ISO string; SDK keeps it as such.
      const tsRaw = (m as { timestamp?: string | number }).timestamp;
      const capturedAt =
        typeof tsRaw === "number"
          ? tsRaw
          : typeof tsRaw === "string"
            ? Date.parse(tsRaw)
            : Number.NaN;
      if (Number.isFinite(capturedAt)) {
        startedAt = Math.min(startedAt, capturedAt);
        updatedAt = Math.max(updatedAt, capturedAt);
      }

      if ((m as { type?: string }).type !== "assistant") continue;

      const message = (
        m as {
          message?: {
            model?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
        }
      ).message;
      const usage = message?.usage;
      if (!usage) continue;
      const model = message?.model;
      if (model && !modelFallback) modelFallback = model;

      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

      // Skip zero-rows (rare — happens when the assistant message is
      // structural rather than an API round-trip).
      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadTokens === 0 &&
        cacheCreationTokens === 0
      ) {
        continue;
      }

      const costUsd = computeCost(model, {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      });

      turns.push({
        turnIndex: turnIndex++,
        capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd,
      });
    }

    return {
      sessionId,
      modelFallback,
      startedAt: Number.isFinite(startedAt) ? startedAt : updatedAt || Date.now(),
      updatedAt: updatedAt || Date.now(),
      turns,
    };
  }

  async listSkills(): Promise<SkillInfo[]> {
    return discoverClaudeSkills(this.workspaceDir);
  }

  listModes(): AgentMode[] {
    return [
      { id: "edit", name: "Edit", description: "Agent can read and edit files" },
      { id: "plan", name: "Plan", description: "Agent creates a plan without making changes" },
    ];
  }

  /**
   * Resolved CLI invocation for `workspaces.create --via terminal`
   * (issue #551). Opens an interactive Claude Code REPL with `prompt`
   * pre-loaded as the first positional argument (cmux-style:
   * `claude "<prompt>"`).
   */
  cliInvocation(prompt: string): CliInvocation {
    return {
      command: this.executablePath ?? CLAUDE_CODE_DEFAULT_BINARY,
      args: [prompt],
    };
  }

  /**
   * No static fallback. The live `supportedModels()` SDK call is the
   * single source of truth; `refreshModels()` populates
   * `~/.band/settings.json` at boot and on user request, and the
   * Settings + chat pickers read from that cache. On a brand-new install
   * before the first successful refresh, the picker is briefly empty —
   * preferable to a hardcoded list that drifts whenever Anthropic ships
   * a new model.
   */
  listModels(): AgentModel[] {
    return [];
  }

  /**
   * Fetch the SDK's `supportedModels()` list. Used by the web server's
   * `ModelRefreshService` to refresh the cached list persisted in
   * `~/.band/settings.json` — both on boot and on explicit user request.
   *
   * `settingSources: []` is the key knob here: it tells the SDK not to
   * load `~/.claude/settings.json` (which is where the `band notify` hook
   * is configured). Without that, every refresh would briefly flip the
   * workspace to "working" via the hook. We do still spin up a Claude
   * Code subprocess (the SDK has no out-of-band model query), but it
   * never sees a hook and we close it immediately after `supportedModels()`
   * resolves.
   *
   * The conversation is created with a no-op prompt — the SDK requires
   * one, but we never iterate the generator and close the conversation
   * before the prompt is consumed.
   *
   * Timeout: a real Claude Code binary returns `supportedModels()` in
   * <100 ms. If we don't hear back within 10 s, we assume the subprocess
   * is wedged (e.g. the configured `pathToClaudeCodeExecutable` is a stub
   * that doesn't speak the SDK protocol — Linux CI exposes this fragility
   * even when macOS hides it) and abort. Crucially, `conversation.close()`
   * runs in `finally` so the wedged subprocess gets killed; without this,
   * the parent server process can hang forever on shutdown waiting for
   * its child's pipes to close.
   */
  async refreshModels(): Promise<AgentModel[]> {
    log.info("refreshing supported models from SDK");
    const conversation = query({
      // The prompt is required by the SDK signature; we close before
      // anything reads it.
      prompt: "",
      options: {
        cwd: this.workspaceDir,
        pathToClaudeCodeExecutable: this.executablePath,
        // Skip loading user/project setting sources so the `band notify`
        // hook (configured in `~/.claude/settings.json`) does not fire
        // during the model-list query. See the JSDoc above.
        settingSources: [],
      },
    });
    // CRITICAL: attach a no-op .catch() to the SDK promise BEFORE the
    // race. When our 10 s timeout wins the race, the SDK's promise is
    // orphaned — if it eventually rejects (e.g. the subprocess exits
    // without responding, as a stub binary would in tests), Node 22+
    // crashes the process on the unhandled rejection. The .catch() here
    // absorbs the late rejection so the boot-time fire-and-forget refresh
    // never takes down the server. The actual rejection is still logged
    // via the `error` channel: the catch we install is purely a guard
    // for the orphaned case.
    const supportedPromise = conversation.supportedModels();
    supportedPromise.catch((err) => {
      log.debug({ err }, "absorbed late supportedModels() rejection");
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = await Promise.race([
        supportedPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("supportedModels() timed out after 10s")),
            10_000,
          );
        }),
      ]);
      log.info({ count: models.length }, "refreshed supported models from SDK");
      return models.map(mapModelInfo);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      try {
        conversation.close();
      } catch (err) {
        log.debug({ err }, "error closing refresh conversation (ignored)");
      }
    }
  }
}

/**
 * Approximate context window per Claude model id. Mirrors the static map in
 * the web meter so SDK-discovered models also surface a window estimate.
 * The runtime `getContextUsage()` value still wins when present.
 *
 *   • [1m] suffix    → 1M long-context tier
 *   • Sonnet 4.x     → 1M (GA at standard pricing, no premium)
 *   • Opus 4.x       → 200k default; the 1M tier requires the [1m] id
 *   • Haiku 4.x      → 200k
 */
function claudeContextForId(id: string): number | undefined {
  if (id.includes("[1m]")) return 1_000_000;
  if (id.startsWith("claude-haiku")) return 200_000;
  if (id.startsWith("claude-opus")) return 200_000;
  if (id.startsWith("claude-sonnet")) return 1_000_000;
  return undefined;
}

function mapModelInfo(info: ModelInfo): AgentModel {
  return {
    id: info.value,
    name: info.displayName,
    description: info.description,
    contextWindow: claudeContextForId(info.value),
  };
}

function mapSessionInfo(info: SDKSessionInfo, lastPrompt?: string): SessionListItem {
  // Match the Claude Code CLI's /resume picker: prefer the user-set
  // custom title, then the most recent prompt, then fall back through
  // the SDK's summary chain (which itself ends in firstPrompt).
  const summary =
    info.customTitle ?? lastPrompt ?? info.summary ?? info.firstPrompt ?? "Untitled session";
  return {
    sessionId: info.sessionId,
    summary,
    lastModified: info.lastModified,
    firstPrompt: info.firstPrompt,
    gitBranch: info.gitBranch,
  };
}

function mapSessionMessage(
  msg: SessionMessage & { type: "user" | "assistant" },
): SessionMessageItem {
  const content: SessionMessageItem["content"] = [];
  const raw = msg.message as {
    content?:
      | string
      | Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
  } | null;

  if (typeof raw?.content === "string") {
    if (raw.content.trim()) {
      content.push({ type: "text", text: raw.content });
    }
  } else if (raw?.content && Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (block.type === "text" && block.text) {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        const toolName = block.name ?? "unknown";
        const input = (block.input ?? {}) as Record<string, unknown>;
        content.push({
          type: "tool_use",
          toolCallId: block.id ?? "",
          toolName,
          displayTitle: formatToolTitle(toolName, input),
          input,
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        const output =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        content.push({
          type: "tool_result",
          toolCallId: block.tool_use_id,
          output,
          isError: block.is_error ?? false,
        });
      }
    }
  }

  return {
    role: msg.type,
    id: msg.uuid,
    content,
  };
}

interface ProcessedState {
  assistantContentIndex: number;
  toolNames: Map<string, string>;
  hasEmittedTextSinceLastUser: boolean;
  /**
   * Set of content-block indices for which we already streamed text via
   * partial `stream_event` deltas during the current API call. When the
   * canonical `assistant` SDK message arrives later, the assistant-case
   * iterator skips these indices so the text is not double-emitted.
   * Cleared on `message_start` (new API call) and on user-turn boundaries.
   */
  streamedTextBlocks: Set<number>;
  /**
   * Type of the most recent content block opened by a partial `stream_event`
   * (`content_block_start`). Used to know whether we owe a `text-end` agent
   * event when the next block starts — e.g. transitioning from a streaming
   * text block into a tool_use block needs to close the bubble before the
   * tool card renders, otherwise the post-tool text would glue back into
   * the same bubble.
   */
  currentStreamBlockType: "text" | "other" | null;
}

function* mapClaudeCodeEvent(
  message: Record<string, unknown>,
  state: ProcessedState,
): Generator<AgentEvent> {
  const type = message.type as string;
  const subtype = message.subtype as string | undefined;

  switch (type) {
    case "system": {
      if (subtype === "init" && message.session_id) {
        yield {
          type: "session-start",
          sessionId: String(message.session_id),
        };
      }
      break;
    }

    case "stream_event": {
      // Partial-message stream emitted by the SDK when `includePartialMessages`
      // is on. Wraps a raw API streaming event (BetaRawMessageStreamEvent).
      // We forward `text_delta`s as fine-grained `text-delta` agent events
      // and use `content_block_start` transitions to emit `text-end` when a
      // text block ends and a non-text block (tool_use, etc.) begins.
      const streamEvent = (message as { event?: Record<string, unknown> }).event;
      if (!streamEvent || typeof streamEvent !== "object") break;
      const evtType = streamEvent.type as string | undefined;

      if (evtType === "message_start") {
        // New API call inside the same runSession (e.g. continuing after a
        // tool_result). Reset per-message stream state. The existing
        // `assistantContentIndex` reset-on-shrink in the assistant case
        // continues to handle the assistant-message side.
        state.streamedTextBlocks.clear();
        state.currentStreamBlockType = null;
        break;
      }

      if (evtType === "content_block_start") {
        const cb = streamEvent.content_block as { type?: string } | undefined;
        const newType: "text" | "other" = cb?.type === "text" ? "text" : "other";
        // Closing transition: streaming text → non-text. Emit a text-end so
        // the task-runner closes the current bubble before the next block
        // (typically a tool_use) renders. Without this, post-tool text would
        // glue back into the pre-tool bubble.
        if (state.currentStreamBlockType === "text" && newType !== "text") {
          yield { type: "text-end" };
        }
        state.currentStreamBlockType = newType;
        break;
      }

      if (evtType === "content_block_delta") {
        const idx = streamEvent.index as number | undefined;
        const delta = streamEvent.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          if (typeof idx === "number") state.streamedTextBlocks.add(idx);
          state.hasEmittedTextSinceLastUser = true;
          state.currentStreamBlockType = "text";
          yield { type: "text-delta", text: delta.text };
        }
        // TODO: stream `input_json_delta` (partial tool args) — out of scope
        // for round 1; partial-JSON rendering needs a UI story. See
        // docs/experiments/partial-messages.md.
        break;
      }

      // content_block_stop / message_delta / message_stop / other delta
      // types (citations, thinking, signature, compaction): ignore for now.
      break;
    }

    case "assistant": {
      const msg = message.message as
        | {
            content?: Array<{
              type: string;
              text?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          }
        | undefined;
      // Note: per-assistant usage is emitted by the caller via
      // `getContextUsage()` so the meter reflects the SDK's full context
      // accounting (system prompt, MCP tools, memory files). Emitting
      // here too would double-broadcast on every assistant message.
      const content = msg?.content;
      if (Array.isArray(content)) {
        // Pre-populate toolNames for all visible tool_use blocks so that
        // tool_result events arriving later can always resolve the name,
        // even when an earlier empty-text block causes the main loop to
        // break before reaching the tool_use block.
        for (const block of content) {
          if (block.type === "tool_use" && block.id && block.name) {
            state.toolNames.set(block.id, block.name);
          }
        }

        let startIdx = state.assistantContentIndex;
        if (content.length < startIdx) {
          // New API call inside the same runSession — content_array reset
          // to 0. Belt-and-suspenders alongside the `message_start` reset:
          // if a stream_event wasn't seen first (older SDK, race, etc.) we
          // still drop stale block-index tracking.
          startIdx = 0;
          state.streamedTextBlocks.clear();
        }

        let processedUpTo = startIdx;
        for (let i = startIdx; i < content.length; i++) {
          const block = content[i];
          if (block.type === "text") {
            if (!block.text) {
              // Text block exists but content hasn't streamed yet;
              // don't advance past it so we re-process on the next event.
              break;
            }
            // If partial deltas already streamed this block via stream_event,
            // skip emitting the full text — it's already in the bubble.
            // Still advance the cursor + flag so downstream logic sees this
            // block as processed.
            if (!state.streamedTextBlocks.has(i)) {
              yield { type: "text-delta", text: block.text };
            }
            state.hasEmittedTextSinceLastUser = true;
            processedUpTo = i + 1;
          } else if (block.type === "tool_use") {
            // Defensive: if a stream_event content_block_start for this
            // tool_use never reached us (or arrived after the assistant
            // message), the previous text bubble is still open. Close it
            // here so the tool card renders below the bubble, not glued
            // into it.
            if (state.currentStreamBlockType === "text") {
              yield { type: "text-end" };
              state.currentStreamBlockType = "other";
            }
            const toolCallId = block.id ?? crypto.randomUUID();
            const toolName = block.name ?? "unknown";
            const input = (block.input ?? {}) as Record<string, unknown>;
            state.toolNames.set(toolCallId, toolName);
            yield {
              type: "tool-use",
              toolCallId,
              toolName,
              displayTitle: formatToolTitle(toolName, input),
              input,
            };
            processedUpTo = i + 1;
          } else {
            processedUpTo = i + 1;
          }
        }

        state.assistantContentIndex = processedUpTo;
      }
      break;
    }

    case "user": {
      state.assistantContentIndex = 0;
      state.hasEmittedTextSinceLastUser = false;
      // New user-turn boundary — drop any stream-block tracking from the
      // previous assistant turn so the next API call's indices don't
      // collide with stale entries.
      state.streamedTextBlocks.clear();
      state.currentStreamBlockType = null;
      const msg = message.message as
        | {
            content?: Array<{
              type: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            }>;
          }
        | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const output =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content ?? "");

            yield {
              type: "tool-result",
              toolCallId: block.tool_use_id,
              toolName: state.toolNames.get(block.tool_use_id),
              output,
              isError: block.is_error ?? false,
            };
          }
        }
      }
      break;
    }

    case "result": {
      const sid = String(message.session_id ?? "");
      const durationMs = (message.duration_ms as number) ?? 0;
      const numTurns = (message.num_turns as number) ?? 0;
      const costUsd = (message.total_cost_usd as number) ?? 0;

      // Note: usage for the terminal `result` event is emitted by the
      // caller (runSession's outer loop) before delegating to this mapper,
      // so it can carry the cached `lastKnownContext` snapshot and the
      // running cumulative `totalProcessedTokens`. Emitting here would
      // double-broadcast and report the inflated accumulated number as
      // current context size.

      // Fallback: if the final assistant text was never streamed via
      // intermediate `assistant` events (e.g. the SDK jumped straight
      // from an empty-text placeholder to the `result` event), emit
      // the text carried on the result payload so it reaches the UI.
      if (subtype === "success" && !state.hasEmittedTextSinceLastUser) {
        const resultText = message.result as string | undefined;
        if (resultText) {
          log.info("emitting result text as fallback (text was not streamed)");
          yield { type: "text-delta", text: resultText };
        }
      }

      if (subtype === "success") {
        yield {
          type: "session-result",
          success: true,
          sessionId: sid,
          durationMs,
          numTurns,
          costUsd,
          errors: [],
        };
      } else {
        const errors = (message.errors as string[]) ?? [`Agent error (${subtype})`];
        yield {
          type: "session-result",
          success: false,
          sessionId: sid,
          durationMs,
          numTurns,
          costUsd,
          errors,
        };
      }
      break;
    }

    case "error": {
      yield {
        type: "error",
        message: "message" in message ? String(message.message) : "Unknown error",
      };
      break;
    }
  }
}

/**
 * Default executable name for Claude Code. Used by callers (e.g. the
 * Band web server's first-time setup) to probe whether the agent is
 * actually reachable on the host before assuming a `claude-code` entry
 * in `settings.codingAgents` corresponds to a working install. Mirrors
 * the binary the SDK shells out to (`claude` on PATH).
 */
export const CLAUDE_CODE_DEFAULT_BINARY = "claude";

/**
 * Where freshly-shipped skills (e.g. the band CLI's bundled SKILL.md files,
 * synced by apps/web/src/server/services/cli-skills.ts on every server boot) should be
 * written. This is the *highest-priority* global directory the discovery
 * tier above scans, matching the personal-scope path documented at
 * https://code.claude.com/docs/en/skills.
 *
 * Defaults to `homedir()` to mirror `discoverClaudeSkills`. Tests pass an
 * explicit `home` so they can sandbox the destination.
 */
export function getClaudeCodeInstallSkillsDir(home: string = homedir()): string {
  return join(home, ".claude", "skills");
}

function discoverClaudeSkills(workspaceDir: string): SkillInfo[] {
  const globalSkillsDir = join(homedir(), ".claude", "skills");
  const projectSkillsDir = join(workspaceDir, ".claude", "skills");

  const globalSkills = readSkillsFromDir(globalSkillsDir);
  const projectSkills = readSkillsFromDir(projectSkillsDir);

  const skillMap = new Map<string, SkillInfo>();
  for (const skill of globalSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    skillMap.set(skill.name, skill);
  }

  return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
