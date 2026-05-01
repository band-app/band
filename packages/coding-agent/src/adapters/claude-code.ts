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
import { readSkillsFromDir } from "../skills.js";
import type {
  AgentMode,
  AgentModel,
  CodingAgent,
  GetSessionMessagesOptions,
  RunSessionOptions,
  SessionInfo,
  SessionListItem,
  SessionMessageItem,
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
  private readonly maxTurns: number;
  private readonly model: string | undefined;
  private readonly executablePath: string | undefined;
  private readonly additionalDirectories: string[] | undefined;
  private activeConversation: ReturnType<typeof query> | null = null;
  private cachedModels: AgentModel[] | null = null;

  constructor(config: ClaudeCodeConfig) {
    this.workspaceDir = config.workspaceDir;
    this.maxTurns = config.maxTurns;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath;
    this.additionalDirectories = config.additionalDirectories;
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
    const effectiveMaxTurns = options?.maxTurns ?? this.maxTurns;
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
        maxTurns: effectiveMaxTurns,
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
        maxTurns: effectiveMaxTurns,
        resume: sessionId,
        canUseTool,
        env,
        additionalDirectories: this.additionalDirectories,
        pathToClaudeCodeExecutable: this.executablePath,
        settingSources: ["user", "project"],
        permissionMode,
        stderr: (data) => log.warn({ data }, "claude-code stderr"),
      },
    });

    this.activeConversation = conversation;
    log.info("query() called, waiting for messages...");

    // Fetch available models from the SDK and cache them
    if (!this.cachedModels) {
      conversation
        .supportedModels()
        .then((models) => {
          this.cachedModels = models.map(mapModelInfo);
          log.info({ count: models.length }, "cached supported models from SDK");
        })
        .catch((err) => {
          log.warn({ err }, "failed to fetch supported models");
        });
    }

    const state: ProcessedState = {
      assistantContentIndex: 0,
      toolNames: new Map(),
      hasEmittedTextSinceLastUser: false,
    };

    try {
      for await (const message of conversation) {
        log.debug(
          {
            messageType: message.type,
            subtype: "subtype" in message ? message.subtype : undefined,
          },
          "sdk message",
        );

        yield* mapClaudeCodeEvent(message, state);
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

  async listSkills(): Promise<SkillInfo[]> {
    return discoverClaudeSkills(this.workspaceDir);
  }

  listModes(): AgentMode[] {
    return [
      { id: "edit", name: "Edit", description: "Agent can read and edit files" },
      { id: "plan", name: "Plan", description: "Agent creates a plan without making changes" },
    ];
  }

  async listModels(): Promise<AgentModel[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }

    // Return defaults until a real session populates the cache.
    // Spawning a Claude Code process just to list models triggers hooks
    // (band notify) which incorrectly sets the workspace status to "working".
    // The cache is populated during the first runSession() call.
    return [
      {
        id: "claude-sonnet-4-6",
        name: "Default (recommended)",
        description: "Use the default model (currently Sonnet 4.6) · $3/$15 per Mtok",
      },
      {
        id: "claude-sonnet-4-6[1m]",
        name: "Sonnet (1M context)",
        description: "Sonnet 4.6 for long sessions · $6/$22.50 per Mtok",
      },
      {
        id: "claude-opus-4-7",
        name: "Opus",
        description: "Opus 4.7 · Most capable for complex work · $5/$25 per Mtok",
      },
      {
        id: "claude-opus-4-7[1m]",
        name: "Opus (1M context)",
        description: "Opus 4.7 for long sessions · $10/$37.50 per Mtok",
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok",
      },
    ];
  }
}

function mapModelInfo(info: ModelInfo): AgentModel {
  return {
    id: info.value,
    name: info.displayName,
    description: info.description,
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
      // Emit a usage snapshot for the latest assistant message so the UI
      // context meter ticks after every LLM round-trip — not just at the
      // final `result` event.
      if (msg?.usage) {
        yield {
          type: "usage",
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
        };
      }
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
          startIdx = 0;
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
            yield { type: "text-delta", text: block.text };
            state.hasEmittedTextSinceLastUser = true;
            processedUpTo = i + 1;
          } else if (block.type === "tool_use") {
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

      const usage = message.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        };
      }

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
