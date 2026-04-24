import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "@band-app/logger";
import type { ThreadEvent, ThreadItem, TodoListItem } from "@openai/codex-sdk";
import { Codex } from "@openai/codex-sdk";
import type { CodexConfig } from "../config.js";
import type { AgentEvent } from "../events.js";
import { readSkillsFromDir } from "../skills.js";
import type {
  AgentMode,
  AgentModel,
  CodingAgent,
  RunSessionOptions,
  SessionListItem,
  SessionMessageItem,
  SkillInfo,
} from "../types.js";

const log = createLogger("coding-agent:codex");

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
  private readonly maxTurns: number;
  private readonly model: string | undefined;
  private readonly executablePath: string | undefined;
  private activeIterator: AsyncIterator<ThreadEvent> | null = null;

  constructor(config: CodexConfig) {
    this.workspaceDir = config.workspaceDir;
    this.maxTurns = config.maxTurns;
    this.model = config.options.model;
    this.executablePath = config.options.executablePath ?? resolveCodexBinary();
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
    const effectiveMaxTurns = options?.maxTurns ?? this.maxTurns;
    const requestedModel = options?.model ?? this.model;
    // Only pass models that Codex actually supports. Ignore models from
    // other providers (e.g. Claude) to let Codex use its own default.
    const knownModelIds = new Set(CODEX_MODELS.map((m) => m.id));
    const effectiveModel = requestedModel && knownModelIds.has(requestedModel) ? requestedModel : undefined;
    const mode = options?.mode ?? "edit";

    log.info(
      {
        prompt: prompt.slice(0, 100),
        sessionId,
        model: effectiveModel,
        cwd: this.workspaceDir,
        maxTurns: effectiveMaxTurns,
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
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // Track the actual thread ID from the SDK — sessionId param may be
    // undefined for new sessions.
    let actualSessionId = sessionId ?? "";

    const runStreamedStartMs = Date.now();
    log.info("calling thread.runStreamed");
    let result: { events: AsyncIterable<ThreadEvent> };
    try {
      result = await thread.runStreamed(prompt);
      log.info({ elapsedMs: Date.now() - runStreamedStartMs }, "thread.runStreamed returned successfully");
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

    try {
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        log.info({ eventType: event.type }, "codex event");

        switch (event.type) {
          // ── Session lifecycle ──────────────────────────────────────────
          case "thread.started": {
            actualSessionId = event.thread_id ?? sessionId ?? "";
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
            totalInputTokens += event.usage.input_tokens;
            totalOutputTokens += event.usage.output_tokens;
            yield {
              type: "session-result",
              success: true,
              sessionId: actualSessionId,
              durationMs: Date.now() - startMs,
              numTurns: turnCount,
              costUsd: 0,
              errors: [],
            };
            break;
          }

          case "turn.failed": {
            yield {
              type: "session-result",
              success: false,
              sessionId: actualSessionId,
              durationMs: Date.now() - startMs,
              numTurns: turnCount,
              costUsd: 0,
              errors: [event.error.message],
            };
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
        { turnCount, totalInputTokens, totalOutputTokens, actualSessionId, elapsedMs: Date.now() - startMs },
        "codex stream done — all events consumed",
      );
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

  listModels(): AgentModel[] {
    return CODEX_MODELS;
  }

  async listSessions(dir: string): Promise<SessionListItem[]> {
    log.info({ dir }, "listSessions");
    const sessions = await readCodexSessions();
    return sessions.filter((s) => s.cwd === dir).sort((a, b) => b.lastModified - a.lastModified);
  }

  async getSessionMessages(
    sessionId: string,
    dir: string,
    options?: { limit?: number; offset?: number },
  ): Promise<SessionMessageItem[]> {
    log.info({ sessionId, dir, ...options }, "getSessionMessages");
    return readCodexSessionMessages(sessionId, options);
  }
}

// ─── Binary resolution ───────────────────────────────────────────────────────

/**
 * Resolve the `codex` binary from the system PATH.
 * The SDK's built-in `findCodexPath()` requires the platform-specific npm
 * package (e.g. `@openai/codex-darwin-arm64`) which we don't bundle.
 * Instead we expect `codex` to be installed on the user's system.
 */
function resolveCodexBinary(): string | undefined {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, ["codex"], { encoding: "utf-8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// ─── Models ─────────────────────────────────────────────────────────────────

const CODEX_MODELS: AgentModel[] = [
  { id: "gpt-5.4", name: "GPT-5.4", description: "Flagship frontier model" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", description: "Fast, efficient mini model" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "Coding-optimized model" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: "Previous coding-optimized model" },
];

// ─── Skills ─────────────────────────────────────────────────────────────────

/**
 * Discover skills from Codex-specific directories:
 *   - ~/.codex/skills/          (global user skills)
 *   - ~/.codex/skills/.system/  (built-in Codex skills)
 *   - <workspace>/.codex/skills/ (project-level skills)
 *
 * Project-level skills override global ones with the same name.
 */
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
  options?: { limit?: number; offset?: number },
): Promise<SessionMessageItem[]> {
  const files = await findSessionFiles();
  const targetFile = files.find((f) => f.includes(sessionId));
  if (!targetFile) return [];

  const messages: SessionMessageItem[] = [];
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

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;

    if (msgIndex >= offset && msgIndex < offset + limit) {
      messages.push({
        role,
        id: `codex-${sessionId}-${msgIndex}`,
        content,
      });
    }
    msgIndex++;

    if (msgIndex >= offset + limit) break;
  }

  return messages;
}
