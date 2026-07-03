import { execFile, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "@band-app/logger";
import type { ThreadEvent, ThreadItem, TodoListItem } from "@openai/codex-sdk";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { AGENT_DISPATCH_ENV } from "../adapter-env.js";
import type { CodexConfig } from "../config.js";
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
  SessionListItem,
  SessionMessageItem,
  SessionUsageSnapshot,
  SessionUsageTurn,
  SkillInfo,
} from "../types.js";

const log = createLogger("coding-agent:codex");

interface CumulativeUsage {
  input: number;
  output: number;
  reasoningOutput: number;
}

/**
 * Per-thread cumulative usage counters, persisted across `runSession`
 * invocations so `totalProcessedTokens` is monotonic across a continuing
 * Codex thread. Module-scoped (lifetime-of-process); not durable across
 * server restarts.
 *
 * Bounded by `MAX_CUMULATIVE_SESSIONS` via insertion-order LRU eviction
 * to prevent unbounded growth in long-running servers.
 */
const cumulativeUsageBySession = new Map<string, CumulativeUsage>();
const MAX_CUMULATIVE_SESSIONS = 500;

/** Bounded-LRU set. JS Map preserves insertion order, so deleting the first
 * key drops the oldest. Re-inserting an existing key bumps it to MRU. */
function lruSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Codex adapter — uses the `@openai/codex-sdk` TypeScript SDK which wraps the
 * Codex CLI binary and exchanges JSONL events over stdin/stdout.
 *
 * Feature mapping vs Claude Code adapter:
 * ─────────────────────────────────────────────────────────
 *  Claude Code feature        │ Codex equivalent
 * ────────────────────────────┼────────────────────────────
 *  Edit mode                  │ sandbox: workspace-write
 *  Plan mode (read-only)      │ sandbox: read-only
 *  Session resume             │ codex.resumeThread(id)
 *  Cost tracking              │ usage tokens on turn.completed
 *  Model selection            │ model option on constructor
 *  Skill discovery            │ ~/.codex/skills/
 *  Mode listing               │ edit / plan
 *  Model listing              │ hardcoded known Codex models
 *  Interactive tools          │ not supported by Codex SDK
 *  Session listing            │ reads from ~/.codex/sessions/
 * ─────────────────────────────────────────────────────────
 */
export class CodexAdapter implements CodingAgent {
  readonly name = "Codex";
  readonly supportedFeatures = {
    costTracking: true,
    sessionListing: true,
  } as const;

  private readonly workspaceDir: string;
  private readonly model: string | undefined;
  private readonly executablePath: string | undefined;
  private activeIterator: AsyncIterator<ThreadEvent> | null = null;

  constructor(config: CodexConfig) {
    this.workspaceDir = config.workspaceDir;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath ?? cachedCodexBinary;
  }

  abort(): void {
    if (this.activeIterator) {
      log.info("aborting active codex stream");
      this.activeIterator.return?.(undefined);
      this.activeIterator = null;
    }
  }

  async *runSession(
    prompt: string,
    sessionId?: string,
    options?: RunSessionOptions,
  ): AsyncGenerator<AgentEvent> {
    // Pass the requested model through verbatim. The chat picker only
    // offers ids the user's refreshed cache (`~/.band/settings.json`)
    // surfaced via `refreshModels()` shelling out to
    // `codex debug models`, so anything reaching us here is either a
    // known Codex id, the agent's configured default, or a foreign
    // provider id left over from a mid-chat agent switch. For the last
    // case Codex itself errors out with a clear "unknown model"
    // message — more informative than the previous silent
    // fallback-to-default behaviour.
    const effectiveModel = options?.model ?? this.model;
    const mode = options?.mode ?? "edit";

    log.info(
      {
        prompt: prompt.slice(0, 100),
        sessionId,
        model: effectiveModel,
        cwd: this.workspaceDir,
        mode,
      },
      "runSession starting",
    );

    // Build a clean environment for the codex binary, stripping Node.js/pnpm
    // runtime vars that may leak from the vite dev server or pnpm scripts.
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      // Skip Node.js/pnpm/npm internal env vars
      if (
        key === "NODE_PATH" ||
        key === "NODE" ||
        key.startsWith("npm_") ||
        key === "INIT_CWD" ||
        key === "PNPM_SCRIPT_SRC_DIR"
      ) {
        continue;
      }
      cleanEnv[key] = value;
    }
    // BAND_DISPATCH=chat so a nested `band` CLI call from this agent
    // dispatches back into a chat pane (see adapter-env.ts).
    Object.assign(cleanEnv, AGENT_DISPATCH_ENV);

    const codex = new Codex({
      ...(this.executablePath ? { codexPathOverride: this.executablePath } : {}),
      env: cleanEnv,
    });

    // Map Band modes to Codex sandbox modes:
    //   edit → workspace-write  (agent can read + write files, run commands)
    //   plan → read-only        (agent can only browse, no modifications)
    const sandboxMode = mode === "plan" ? ("read-only" as const) : ("workspace-write" as const);

    const thread = sessionId
      ? codex.resumeThread(sessionId, {
          workingDirectory: this.workspaceDir,
          sandboxMode,
          model: effectiveModel,
          approvalPolicy: "never",
        })
      : codex.startThread({
          workingDirectory: this.workspaceDir,
          sandboxMode,
          model: effectiveModel,
          approvalPolicy: "never",
        });

    const startMs = Date.now();
    let turnCount = 0;
    // Track the actual thread ID from the SDK — sessionId param may be
    // undefined for new sessions.
    let actualSessionId = sessionId ?? "";

    // Cumulative thread totals — persisted in `cumulativeUsageBySession`
    // keyed by thread id so they survive `runSession` boundaries. New threads
    // start at zero; resumed threads pick up where the prior run left off.
    const initialCumulative = actualSessionId
      ? cumulativeUsageBySession.get(actualSessionId)
      : undefined;
    let totalInputTokens = initialCumulative?.input ?? 0;
    let totalOutputTokens = initialCumulative?.output ?? 0;
    let totalReasoningOutputTokens = initialCumulative?.reasoningOutput ?? 0;

    const persistCumulative = () => {
      if (!actualSessionId) return;
      lruSet(
        cumulativeUsageBySession,
        actualSessionId,
        {
          input: totalInputTokens,
          output: totalOutputTokens,
          reasoningOutput: totalReasoningOutputTokens,
        },
        MAX_CUMULATIVE_SESSIONS,
      );
    };

    // Migrate stored cumulative under a newly-resolved thread id. Called when
    // `thread.started` reports a thread_id different from the one we
    // initialised with — typically for brand-new threads.
    const adoptSessionId = (newSid: string) => {
      if (!newSid || newSid === actualSessionId) return;
      const prevStored = actualSessionId
        ? cumulativeUsageBySession.get(actualSessionId)
        : undefined;
      if (prevStored) {
        lruSet(cumulativeUsageBySession, newSid, prevStored, MAX_CUMULATIVE_SESSIONS);
        cumulativeUsageBySession.delete(actualSessionId);
      }
      actualSessionId = newSid;
      persistCumulative();
    };

    const runStreamedStartMs = Date.now();
    log.info("calling thread.runStreamed");
    let result: { events: AsyncIterable<ThreadEvent> };
    try {
      result = await thread.runStreamed(prompt);
      log.info(
        { elapsedMs: Date.now() - runStreamedStartMs },
        "thread.runStreamed returned successfully",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, cwd: this.workspaceDir, model: effectiveModel }, "codex runStreamed failed");
      yield { type: "error", message: msg };
      yield {
        type: "session-result",
        success: false,
        sessionId: actualSessionId,
        durationMs: Date.now() - startMs,
        numTurns: 0,
        costUsd: 0,
        errors: [msg],
      };
      return;
    }

    const iterator = result.events[Symbol.asyncIterator]();
    this.activeIterator = iterator;

    // Track tool names across events so tool-result can reference the name
    const toolNames = new Map<string, string>();
    // Track emitted text length per item to compute deltas on item.updated
    const emittedTextLengths = new Map<string, number>();
    // Buffer terminal turn state — emit a single session-result *after* the
    // iterator exhausts so multi-turn sessions don't yield duplicate finishes.
    let lastTurnOutcome: "completed" | "failed" | null = null;
    let lastTurnError: string | null = null;

    try {
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        log.debug({ eventType: event.type }, "codex event");

        switch (event.type) {
          // ── Session lifecycle ──────────────────────────────────────────
          case "thread.started": {
            const resolvedSid = event.thread_id ?? sessionId ?? "";
            adoptSessionId(resolvedSid);
            log.info(
              { threadId: event.thread_id, sessionIdParam: sessionId, actualSessionId },
              "codex thread.started",
            );
            yield {
              type: "session-start",
              sessionId: actualSessionId,
            };
            break;
          }

          // ── Item lifecycle ────────────────────────────────────────────
          case "item.started": {
            yield* handleItemStarted(event.item, toolNames);
            break;
          }

          case "item.updated": {
            yield* handleItemUpdated(event.item, emittedTextLengths);
            break;
          }

          case "item.completed": {
            yield* handleItemCompleted(event.item, toolNames, emittedTextLengths);
            break;
          }

          // ── Turn lifecycle ────────────────────────────────────────────
          case "turn.started": {
            turnCount++;
            break;
          }

          case "turn.completed": {
            // Codex CLI versions vary: some omit individual usage fields. Coerce
            // each to 0 so a missing field doesn't NaN the broadcast (ChatView
            // silently drops data-usage chunks without numeric inputTokens).
            const usage = event.usage ?? {
              input_tokens: 0,
              output_tokens: 0,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            };
            const inputTokens = usage.input_tokens ?? 0;
            const outputTokens = usage.output_tokens ?? 0;
            const cachedInputTokens = usage.cached_input_tokens ?? 0;
            const reasoningOutputTokens = usage.reasoning_output_tokens ?? 0;
            const contextTokens = inputTokens + outputTokens + reasoningOutputTokens;
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            totalReasoningOutputTokens += reasoningOutputTokens;
            persistCumulative();
            // OpenAI Responses API: `input_tokens` is the full prompt sent to
            // the model for this turn (already inclusive of cached content).
            // `cached_input_tokens` is a subset for visibility only. Match the
            // t3code-style split: current window usage is the latest turn's
            // total, while totalProcessedTokens is cumulative session work.
            log.debug(
              {
                inputTokens,
                outputTokens,
                cachedInputTokens,
                reasoningOutputTokens,
                contextTokens,
                totalProcessed: totalInputTokens + totalOutputTokens + totalReasoningOutputTokens,
              },
              "codex usage emitted",
            );
            yield {
              type: "usage",
              provider: "codex",
              inputTokens,
              outputTokens,
              cacheReadTokens: cachedInputTokens,
              reasoningOutputTokens,
              contextTokens,
              totalProcessedTokens:
                totalInputTokens + totalOutputTokens + totalReasoningOutputTokens,
            };
            lastTurnOutcome = "completed";
            lastTurnError = null;
            break;
          }

          case "turn.failed": {
            lastTurnOutcome = "failed";
            lastTurnError = event.error.message;
            break;
          }

          // ── Errors ────────────────────────────────────────────────────
          case "error": {
            yield {
              type: "error",
              message: event.message,
            };
            break;
          }
        }
      }
      log.info(
        {
          turnCount,
          totalInputTokens,
          totalOutputTokens,
          totalReasoningOutputTokens,
          actualSessionId,
          elapsedMs: Date.now() - startMs,
        },
        "codex stream done — all events consumed",
      );

      // Emit a single terminal session-result reflecting the last turn outcome.
      if (lastTurnOutcome !== null) {
        yield {
          type: "session-result",
          success: lastTurnOutcome === "completed",
          sessionId: actualSessionId,
          durationMs: Date.now() - startMs,
          numTurns: turnCount,
          costUsd: 0,
          errors: lastTurnError ? [lastTurnError] : [],
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, cwd: this.workspaceDir }, "codex stream error");
      yield { type: "error", message: msg };
      yield {
        type: "session-result",
        success: false,
        sessionId: actualSessionId,
        durationMs: Date.now() - startMs,
        numTurns: turnCount,
        costUsd: 0,
        errors: [msg],
      };
    } finally {
      this.activeIterator = null;
    }
  }

  async listSkills(): Promise<SkillInfo[]> {
    return discoverCodexSkills(this.workspaceDir);
  }

  listModes(): AgentMode[] {
    return [
      { id: "edit", name: "Edit", description: "Agent can read, edit files, and run commands" },
      { id: "plan", name: "Plan", description: "Agent browses files in read-only mode" },
    ];
  }

  /**
   * No static fallback. The live `codex debug models` output is the
   * single source of truth; `refreshModels()` populates
   * `~/.band/settings.json` at boot and on user request, and the
   * Settings + chat pickers read from that cache. On a brand-new install
   * before the first successful refresh, the picker is briefly empty —
   * preferable to a hardcoded list that drifts whenever OpenAI ships a
   * new model.
   */
  listModels(): AgentModel[] {
    return [];
  }

  /**
   * Discover the live model catalog by shelling out to `codex debug models`,
   * which renders the SDK's known model catalog as JSON (one entry per model
   * with `slug`, `display_name`, `description`, `visibility`, `priority`, and
   * `context_window`). The `debug` subcommand is undocumented in user-facing
   * help but ships in every released `codex` binary; if its shape ever drifts,
   * the JSON parse will throw and `ModelRefreshService.refresh()` keeps the
   * previously cached list intact.
   *
   * Filtering: entries with `visibility === "hide"` are internal models the
   * Codex UI never surfaces (e.g. `codex-auto-review`), so we drop them too.
   * Sort by `priority` so the picker order matches what `codex` ships.
   */
  async refreshModels(): Promise<AgentModel[]> {
    const binary = this.executablePath ?? CODEX_DEFAULT_BINARY;
    log.info({ binary }, "refreshing supported models from codex debug models");
    const raw = await new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        ["debug", "models"],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stdout);
        },
      );
    });
    // The shape of `codex debug models` is set by upstream. Guard the
    // envelope (`{ models: [...] }`), then validate each element against
    // `codexDebugModelSchema` — malformed entries are dropped rather than
    // discarding the whole catalog, and the schema's `.passthrough()`
    // tolerates the many fields we don't read.
    const parsedUnknown = JSON.parse(raw) as unknown;
    if (typeof parsedUnknown !== "object" || parsedUnknown === null) {
      throw new Error("codex debug models did not return a JSON object");
    }
    const models = (parsedUnknown as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      throw new Error("codex debug models did not include a `models` array");
    }
    const validated: CodexDebugModel[] = [];
    for (const entry of models) {
      const parsed = codexDebugModelSchema.safeParse(entry);
      if (parsed.success) {
        validated.push(parsed.data);
      } else {
        log.warn({ entry }, "skipping malformed codex model catalog entry");
      }
    }
    const visible = validated
      .filter((m) => m.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    log.info({ count: visible.length }, "refreshed supported models from codex");
    return visible.map(
      (m): AgentModel => ({
        id: m.slug,
        name: m.display_name || m.slug,
        description: m.description,
        contextWindow: m.context_window,
      }),
    );
  }

  /**
   * Resolved CLI invocation for `workspaces.create --via terminal`
   * (issue #551). Opens an interactive Codex REPL with `prompt` pre-loaded
   * as the first positional argument (cmux-style: `codex "<prompt>"`).
   */
  cliInvocation(prompt: string): CliInvocation {
    return {
      command: this.executablePath ?? CODEX_DEFAULT_BINARY,
      args: [prompt],
    };
  }

  /**
   * Resume CLI invocation for the chat tab's "Continue in terminal" action.
   * `codex resume <session-id>` reopens the interactive Codex TUI with that
   * thread restored.
   */
  resumeCliInvocation(sessionId: string): CliInvocation {
    return {
      command: this.executablePath ?? CODEX_DEFAULT_BINARY,
      args: ["resume", sessionId],
    };
  }

  async listSessions(dir: string): Promise<SessionListItem[]> {
    log.debug({ dir }, "listSessions");
    const sessions = await readCodexSessions();
    return sessions.filter((s) => s.cwd === dir).sort((a, b) => b.lastModified - a.lastModified);
  }

  async getSessionMessages(
    sessionId: string,
    dir: string,
    options?: GetSessionMessagesOptions,
  ): Promise<{ messages: SessionMessageItem[]; hasMore: boolean; firstOffset: number }> {
    log.info({ sessionId, dir, ...options }, "getSessionMessages");
    return readCodexSessionMessages(sessionId, options);
  }

  /**
   * Read per-turn token usage for one Codex session, computing cost via
   * the local ratecard (`packages/coding-agent/src/pricing.ts`) since the
   * OpenAI Responses API doesn't surface a `costUsd` field the way the
   * Claude SDK does.
   *
   * Codex emits `event_msg` lines with `payload.type == "token_count"` in
   * its rollout JSONL. Each carries a `last_token_usage` (delta for that
   * turn) and a `total_token_usage` (cumulative). We use **`last_token_usage`**
   * — summing `total_token_usage` would massively double-count (the
   * 91× inflation bug ccusage hit: github.com/ryoppippi/ccusage/issues/950).
   *
   * Model attribution: the most recent `turn_context` event preceding a
   * `token_count` carries the model id (Codex supports switching models
   * mid-session). We track the running `currentModel` as we walk the
   * file.
   *
   * Subagent guard: if the session's `session_meta` has a
   * `parent_thread_id`, the rollout re-replays the parent's history
   * with the subagent's creation timestamp. Skip those re-replays to
   * avoid the same 91× inflation — we treat subagent rollouts as
   * non-billable echoes and let the parent rollout carry the real cost.
   */
  async getSessionUsage(sessionId: string, _dir: string): Promise<SessionUsageSnapshot | null> {
    const files = await findSessionFiles();
    let targetFile: string | undefined;

    // Optimistic path: rollout files end with the session id (e.g.
    // `rollout-2026-04-19T11-23-00-<sessionId>.jsonl`), so we can short-
    // circuit the linear scan with an `endsWith` check before opening any
    // files. Fall back to `session_meta` scan if naming drifts.
    for (const f of files) {
      if (f.endsWith(`${sessionId}.jsonl`)) {
        targetFile = f;
        break;
      }
    }
    if (!targetFile) {
      for (const f of files) {
        try {
          const rl = createInterface({
            input: createReadStream(f),
            crlfDelay: Number.POSITIVE_INFINITY,
          });
          for await (const line of rl) {
            const obj = JSON.parse(line) as { type?: string; payload?: { id?: string } };
            if (obj.type === "session_meta" && obj.payload?.id === sessionId) {
              targetFile = f;
              break;
            }
            // Only the first line is the meta; bail out after a few
            // lines if we don't see one (file isn't a Codex rollout).
            break;
          }
        } catch {
          // Skip unreadable files.
        }
        if (targetFile) break;
      }
    }
    if (!targetFile) return null;

    const turns: SessionUsageTurn[] = [];
    let turnIndex = 0;
    let startedAt = Number.POSITIVE_INFINITY;
    let updatedAt = 0;
    let modelFallback = "";
    let currentModel: string | undefined;
    let isSubagent = false;

    const rl = createInterface({
      input: createReadStream(targetFile),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: {
        type?: string;
        timestamp?: string;
        payload?: Record<string, unknown>;
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const tsMs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
      if (Number.isFinite(tsMs)) {
        startedAt = Math.min(startedAt, tsMs);
        updatedAt = Math.max(updatedAt, tsMs);
      }

      if (obj.type === "session_meta") {
        // The presence of `parent_thread_id` marks this rollout as a
        // subagent replay. We flip a flag and return empty turns —
        // the parent's rollout will carry the real cost (see ccusage
        // issue #950).
        const parent = obj.payload?.parent_thread_id;
        if (typeof parent === "string" && parent.length > 0) {
          isSubagent = true;
          break;
        }
        continue;
      }

      if (obj.type === "turn_context") {
        const model = (obj.payload as { model?: string })?.model;
        if (typeof model === "string" && model.length > 0) {
          currentModel = model;
          if (!modelFallback) modelFallback = model;
        }
        continue;
      }

      if (obj.type !== "event_msg") continue;
      const payload = obj.payload as
        | {
            type?: string;
            info?: {
              last_token_usage?: {
                input_tokens?: number;
                cached_input_tokens?: number;
                output_tokens?: number;
                reasoning_output_tokens?: number;
              };
            };
          }
        | undefined;
      if (payload?.type !== "token_count") continue;
      const last = payload.info?.last_token_usage;
      if (!last) continue;

      const inputTokens = Number(last.input_tokens ?? 0);
      const cacheReadTokens = Number(last.cached_input_tokens ?? 0);
      const outputTokens = Number(last.output_tokens ?? 0);
      const reasoningOutputTokens = Number(last.reasoning_output_tokens ?? 0);

      // Codex's `input_tokens` is the FULL prompt size (already inclusive
      // of cached content). The ratecard prices the uncached fresh input
      // separately from cache reads, so we subtract the cached subset
      // before pricing — otherwise we'd over-charge by the cache discount.
      // Floor at 0 in case the SDK ever inverts (defensive).
      const uncachedInput = Math.max(0, inputTokens - cacheReadTokens);

      const cost = computeCost(currentModel, {
        inputTokens: uncachedInput,
        outputTokens,
        cacheReadTokens,
        reasoningOutputTokens,
      });

      turns.push({
        turnIndex: turnIndex++,
        capturedAt: Number.isFinite(tsMs) ? tsMs : Date.now(),
        model: currentModel,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        reasoningOutputTokens,
        costUsd: cost,
      });
    }

    if (isSubagent) {
      // Bail out: subagent rollouts double-count parent usage. Return an
      // empty turn list (still a valid snapshot so the scanner advances
      // its watermark) so a future read doesn't re-attempt.
      return {
        sessionId,
        modelFallback,
        startedAt: Number.isFinite(startedAt) ? startedAt : updatedAt || Date.now(),
        updatedAt: updatedAt || Date.now(),
        turns: [],
      };
    }

    return {
      sessionId,
      modelFallback,
      startedAt: Number.isFinite(startedAt) ? startedAt : updatedAt || Date.now(),
      updatedAt: updatedAt || Date.now(),
      turns,
    };
  }
}

// ─── Binary resolution ───────────────────────────────────────────────────────

/**
 * Resolve the `codex` binary from the system PATH.
 *
 * The SDK's built-in `findCodexPath()` requires the platform-specific npm
 * package (e.g. `@openai/codex-darwin-arm64`) which we don't bundle.
 * Instead we expect `codex` to be installed on the user's system.
 *
 * **Must remain a module-level const.** The constructor now runs on
 * the hot `workspaces.create --via terminal` path (workspace-service →
 * `agentService.createWorkspaceAgent` may pick this adapter), and the
 * underlying `execFileSync("which", ["codex"])` blocks the Node event
 * loop for 1–10 ms per invocation. Moving this inside a function or a
 * lazily-evaluated path would re-introduce that per-request cost. The
 * `which` result is process-stable — the user's PATH doesn't change
 * mid-process — so resolving it once at module load is safe.
 */
const cachedCodexBinary: string | undefined = (() => {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, ["codex"], { encoding: "utf-8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

// ─── Models ─────────────────────────────────────────────────────────────────

/**
 * Zod schema for the subset of the `codex debug models` JSON we consume.
 * `.passthrough()` keeps the many fields we don't read (`base_instructions`,
 * `supported_reasoning_levels`, `availability_nux`, …) without rejecting
 * the element, while still enforcing that `slug` is a string and the
 * optional fields, when present, have the expected types. Validated
 * per-element in `refreshModels()` so a single malformed entry is skipped
 * rather than discarding the whole catalog.
 */
const codexDebugModelSchema = z
  .object({
    slug: z.string(),
    display_name: z.string().optional(),
    description: z.string().optional(),
    visibility: z.string().optional(),
    priority: z.number().optional(),
    context_window: z.number().optional(),
  })
  .passthrough();

type CodexDebugModel = z.infer<typeof codexDebugModelSchema>;

// ─── Skills ─────────────────────────────────────────────────────────────────

/**
 * Discover skills from Codex-specific directories:
 *   - ~/.codex/skills/          (global user skills)
 *   - ~/.codex/skills/.system/  (built-in Codex skills)
 *   - <workspace>/.codex/skills/ (project-level skills)
 *
 * Project-level skills override global ones with the same name.
 */
/** Default executable name for the Codex CLI. See `setup.ts::AGENT_CHECKS`. */
export const CODEX_DEFAULT_BINARY = "codex";

/**
 * Where freshly-shipped skills should be written. Codex documents its
 * user-scope skill home as `~/.codex/skills/` (the `.system/` subfolder is
 * reserved for OpenAI-shipped skills shipped with the CLI), with `CODEX_HOME`
 * env override honored for users who have relocated their Codex config.
 *
 * Reads `CODEX_HOME` at call time rather than reusing the module-level
 * `CODEX_HOME` constant so tests that override the env var get the new
 * value. See https://developers.openai.com/codex/skills.
 */
export function getCodexInstallSkillsDir(home: string = homedir()): string {
  // `||` (not `??`) so empty-string `$CODEX_HOME=` falls back to
  // `~/.codex` instead of returning `"/skills"`. Module-level
  // `CODEX_HOME` at the bottom of this file already uses the same
  // guard; keep both consistent.
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  return join(codexHome, "skills");
}

function discoverCodexSkills(workspaceDir: string): SkillInfo[] {
  const globalSkillsDir = join(CODEX_HOME, "skills");
  const systemSkillsDir = join(CODEX_HOME, "skills", ".system");
  const projectSkillsDir = join(workspaceDir, ".codex", "skills");

  const systemSkills = readSkillsFromDir(systemSkillsDir);
  const globalSkills = readSkillsFromDir(globalSkillsDir);
  const projectSkills = readSkillsFromDir(projectSkillsDir);

  const skillMap = new Map<string, SkillInfo>();
  for (const skill of systemSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of globalSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    skillMap.set(skill.name, skill);
  }

  return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseInput(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  if (typeof args === "object" && args !== null) {
    return args as Record<string, unknown>;
  }
  return {};
}

/**
 * Convert Codex `todo_list` items to the `TodoWrite` format expected by the
 * dashboard's task-state.ts parser.
 */
function codexTodosToTodoWrite(item: TodoListItem): { content: string; status: string }[] {
  return item.items.map((todo) => ({
    content: todo.text,
    status: todo.completed ? "completed" : "in_progress",
  }));
}

// ─── Item event handlers ────────────────────────────────────────────────────

function* handleItemStarted(
  item: ThreadItem,
  toolNames: Map<string, string>,
): Generator<AgentEvent> {
  switch (item.type) {
    case "command_execution": {
      const name = "Bash";
      toolNames.set(item.id, name);
      yield {
        type: "tool-use",
        toolCallId: item.id,
        toolName: name,
        input: { command: item.command },
      };
      break;
    }

    case "file_change": {
      const name = "FileEdit";
      toolNames.set(item.id, name);
      yield {
        type: "tool-use",
        toolCallId: item.id,
        toolName: name,
        input: { changes: item.changes },
      };
      break;
    }

    case "mcp_tool_call": {
      const name = item.server ? `${item.server}:${item.tool}` : item.tool;
      toolNames.set(item.id, name);
      yield {
        type: "tool-use",
        toolCallId: item.id,
        toolName: name,
        input: parseInput(item.arguments),
      };
      break;
    }

    case "todo_list": {
      const name = "TodoWrite";
      toolNames.set(item.id, name);
      yield {
        type: "tool-use",
        toolCallId: item.id,
        toolName: name,
        input: { todos: codexTodosToTodoWrite(item) },
      };
      break;
    }

    case "web_search": {
      const name = "WebSearch";
      toolNames.set(item.id, name);
      yield {
        type: "tool-use",
        toolCallId: item.id,
        toolName: name,
        input: { query: item.query },
      };
      break;
    }

    case "error": {
      yield {
        type: "error",
        message: item.message,
      };
      break;
    }

    // agent_message at item.started level is usually empty; text arrives
    // through item.updated / item.completed events.
  }
}

/**
 * Map a Codex item.updated event to AgentEvent(s).
 *
 * The SDK sends progressive updates for agent_message items containing the
 * accumulated text so far. We track what has been emitted and yield only the
 * new delta.
 */
function* handleItemUpdated(
  item: ThreadItem,
  emittedTextLengths: Map<string, number>,
): Generator<AgentEvent> {
  if (item.type !== "agent_message") return;

  const fullText = item.text;
  if (!fullText) return;

  const alreadyEmitted = emittedTextLengths.get(item.id) ?? 0;
  if (fullText.length > alreadyEmitted) {
    const delta = fullText.slice(alreadyEmitted);
    emittedTextLengths.set(item.id, fullText.length);
    yield { type: "text-delta", text: delta };
  }
}

/**
 * Map a Codex item.completed event to AgentEvent(s).
 */
function* handleItemCompleted(
  item: ThreadItem,
  toolNames: Map<string, string>,
  emittedTextLengths: Map<string, number>,
): Generator<AgentEvent> {
  switch (item.type) {
    case "command_execution": {
      yield {
        type: "tool-result",
        toolCallId: item.id,
        toolName: toolNames.get(item.id) ?? "Bash",
        output: item.aggregated_output,
        isError: item.exit_code !== undefined && item.exit_code !== 0,
      };
      break;
    }

    case "file_change": {
      yield {
        type: "tool-result",
        toolCallId: item.id,
        toolName: toolNames.get(item.id) ?? "FileEdit",
        output: item.status,
        isError: item.status === "failed",
      };
      break;
    }

    case "mcp_tool_call": {
      const output = item.error ? item.error.message : JSON.stringify(item.result ?? "");
      yield {
        type: "tool-result",
        toolCallId: item.id,
        toolName: toolNames.get(item.id),
        output,
        isError: item.status === "failed",
      };
      break;
    }

    case "todo_list": {
      yield {
        type: "tool-use",
        toolCallId: item.id,
        toolName: toolNames.get(item.id) ?? "TodoWrite",
        input: { todos: codexTodosToTodoWrite(item) },
      };
      yield {
        type: "tool-result",
        toolCallId: item.id,
        toolName: toolNames.get(item.id) ?? "TodoWrite",
        output: "Todos updated",
        isError: false,
      };
      break;
    }

    case "web_search": {
      yield {
        type: "tool-result",
        toolCallId: item.id,
        toolName: toolNames.get(item.id) ?? "WebSearch",
        output: "Search completed",
        isError: false,
      };
      break;
    }

    case "agent_message": {
      // Emit any remaining text that wasn't already streamed via item.updated
      const fullText = item.text;
      if (!fullText) break;
      const alreadyEmitted = emittedTextLengths.get(item.id) ?? 0;
      if (fullText.length > alreadyEmitted) {
        yield { type: "text-delta", text: fullText.slice(alreadyEmitted) };
        emittedTextLengths.set(item.id, fullText.length);
      }
      break;
    }
  }
}

// ─── Session history (reads from ~/.codex/sessions/) ────────────────────────

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");

/** Recursively find all .jsonl session files under ~/.codex/sessions/ */
async function findSessionFiles(): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) {
        await walk(full);
      } else if (entry.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  await walk(SESSIONS_DIR);
  return results;
}

interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
  git?: { branch?: string };
}

interface CodexSessionEntry extends SessionListItem {
  cwd: string;
}

/** Read the first line (session_meta) from each session file. */
async function readCodexSessions(): Promise<CodexSessionEntry[]> {
  const files = await findSessionFiles();
  const sessions: CodexSessionEntry[] = [];

  for (const file of files) {
    try {
      const rl = createInterface({
        input: createReadStream(file),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      let meta: CodexSessionMeta | null = null;
      let firstPrompt: string | undefined;

      for await (const line of rl) {
        const obj = JSON.parse(line) as { type: string; payload: Record<string, unknown> };

        if (obj.type === "session_meta") {
          meta = obj.payload as unknown as CodexSessionMeta;
        }

        // Find first user message that isn't system/developer boilerplate
        if (!firstPrompt && obj.type === "response_item") {
          const payload = obj.payload as {
            role?: string;
            content?: Array<{ type: string; text?: string }>;
          };
          if (payload.role === "user" && Array.isArray(payload.content)) {
            for (const c of payload.content) {
              if (c.type === "input_text" && c.text && !c.text.startsWith("<")) {
                firstPrompt = c.text.slice(0, 200);
                break;
              }
            }
          }
        }

        if (meta && firstPrompt) break;
      }

      if (meta) {
        const fileStat = await stat(file);
        sessions.push({
          sessionId: meta.id,
          cwd: meta.cwd,
          summary: firstPrompt ?? "Untitled session",
          lastModified: fileStat.mtimeMs,
          firstPrompt,
          gitBranch: meta.git?.branch,
        });
      }
    } catch (err) {
      log.debug({ err, file }, "failed to parse codex session file");
    }
  }

  return sessions;
}

/** Read messages from a specific session file. */
async function readCodexSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<{ messages: SessionMessageItem[]; hasMore: boolean; firstOffset: number }> {
  const files = await findSessionFiles();
  const targetFile = files.find((f) => f.includes(sessionId));
  if (!targetFile) return { messages: [], hasMore: false, firstOffset: 0 };

  const tail = options?.tail;
  const offset = options?.offset ?? 0;
  const limit = options?.limit;
  // "+1 trick": over-fetch by one to detect hasMore without a separate
  // total count. For `tail`, the ring buffer holds at most `tail + 1`
  // entries; for offset/limit, we stop after `offset + limit + 1`.
  const ringCap = tail !== undefined ? Math.max(0, tail) + 1 : 0;
  const stopAt = limit !== undefined ? offset + Math.max(0, limit) + 1 : Number.POSITIVE_INFINITY;
  const ring: SessionMessageItem[] = [];
  const collected: SessionMessageItem[] = [];

  const rl = createInterface({
    input: createReadStream(targetFile),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let msgIndex = 0;

  for await (const line of rl) {
    const obj = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
    if (obj.type !== "response_item") continue;

    const payload = obj.payload as {
      type?: string;
      role?: string;
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        call_id?: string;
        output?: string;
        is_error?: boolean;
      }>;
    };

    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;

    // Skip developer/system messages disguised as user
    if (role === "user" && Array.isArray(payload.content)) {
      const hasRealContent = payload.content.some(
        (c) => c.type === "input_text" && c.text && !c.text.startsWith("<"),
      );
      if (!hasRealContent) continue;
    }

    const content: SessionMessageItem["content"] = [];
    if (Array.isArray(payload.content)) {
      for (const block of payload.content) {
        if ((block.type === "input_text" || block.type === "output_text") && block.text) {
          if (!block.text.startsWith("<")) {
            content.push({ type: "text", text: block.text });
          }
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool_use",
            toolCallId: block.id ?? block.call_id ?? "",
            toolName: block.name ?? "unknown",
            input: block.input ?? {},
          });
        } else if (block.type === "tool_result" && (block.tool_use_id ?? block.call_id)) {
          content.push({
            type: "tool_result",
            toolCallId: block.tool_use_id ?? block.call_id ?? "",
            output:
              typeof block.output === "string" ? block.output : JSON.stringify(block.output ?? ""),
            isError: block.is_error ?? false,
          });
        }
      }
    }

    if (content.length === 0) continue;

    const item: SessionMessageItem = {
      role,
      id: `codex-${sessionId}-${msgIndex}`,
      content,
    };

    if (tail !== undefined) {
      ring.push(item);
      if (ring.length > ringCap) ring.shift();
    } else if (msgIndex >= offset && (limit === undefined || msgIndex < offset + limit + 1)) {
      collected.push(item);
    }
    msgIndex++;

    // Early-exit for offset/limit once we've collected one beyond the
    // window. We've answered both "what's the slice" and "is there more"
    // — no need to walk the rest of the file.
    if (limit !== undefined && msgIndex >= stopAt) break;
  }

  if (tail !== undefined) {
    const tailSize = Math.max(0, tail);
    const hasMore = ring.length > tailSize;
    const slice = hasMore ? ring.slice(1) : ring;
    // The ring's first element sits at index `msgIndex - ring.length` in
    // the full filtered list.
    const ringStart = msgIndex - ring.length;
    return {
      messages: slice,
      hasMore,
      firstOffset: ringStart + (hasMore ? 1 : 0),
    };
  }

  const requested = limit ?? Number.POSITIVE_INFINITY;
  const hasMore = limit !== undefined && collected.length > requested;
  const slice = hasMore ? collected.slice(0, requested) : collected;
  return { messages: slice, hasMore, firstOffset: offset };
}
