import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import type { UIMessageChunk } from "ai";
import { WorkspaceNotFoundError } from "../errors";
import { getAgent, getOrCreateAgent, replaceAgent } from "../infra/agents/agent-pool";
import { generateTaskId, TaskQueries } from "../infra/db/queries/tasks";
import { mimeTypeFromFilename } from "./_utils/mime-types";
import { shiftQueuedMessage } from "./_utils/queued-message-store";
import { chatService } from "./chat-service";
import { bandHome, upsertWorkspaceStatus } from "./state";
import { emit as emitStatusEvent } from "./watcher-service";
// FRAGILE: ESM cycle leg — `workspace-service` imports `submitTask` /
// `abortTask` back from this file. The cycle is safe only because every
// `workspaceService` call below (including the `abortTask` →
// `clearQueuedMessages` chain that powers `WorkspaceService.switchAgent`)
// sits inside a function body — ESM live binding fills the reference at
// call time. Capturing `const ws = workspaceService;` at the top of this
// file would silently get `undefined`.
import { workspaceService } from "./workspace-service";

const log = createLogger("task-service");

/**
 * Task lifecycle, session-event buffer, and pending-input plumbing
 * (Phase 6 of the 3-tier refactor — issue #317).
 *
 * Absorbs the legacy:
 *   - `lib/task-runner.ts` — submit/abort/cancel + the agent event loop.
 *   - `lib/pending-inputs.ts` — `AskUserQuestion` / `ExitPlanMode` resolver
 *     map. Folded in here because the only producer (the agent event loop)
 *     and the consumer (the chat `answer` mutation) both live in the task
 *     domain.
 *   - `lib/session-store.ts` — session-buffer read helpers used by the
 *     chat-events stream for gap-fill replay. Lives here because the
 *     buffer it reads is owned by the task event loop.
 *
 * Kept as plain function exports rather than a class because the state
 * (`tasks`, `listeners`, `sessionBuffers`, `sessionUsage`,
 * `pendingInputs`) is held on `globalThis` symbols so it survives module
 * re-evaluation in dev (vite/HMR) and across multiple bundles (esbuild
 * start-server.mjs vs. Vite SSR server.js produce separate copies of
 * this module). Wrapping the singletons in a class would either leak the
 * symbol-keyed state into the type signature or duplicate it per-instance,
 * defeating the singleton guarantee that all callers see the same buffer.
 *
 * Service-tier rule: the only outward-facing dependencies of this module
 * are infra (`agent-pool`, `TaskQueries`) and other services / shared lib
 * helpers. The API tier (`server/api/tasks/router.ts` and
 * `server/api/sessions/router.ts`) calls these exports; this module never
 * imports from `api/`.
 */

const taskQueries = new TaskQueries();

/**
 * List filenames in a directory. Returns a Set for quick membership checks.
 */
function listFiles(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

const MAX_TOOL_OUTPUT_LEN = 10_000;

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LEN) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LEN)}\n\n[output truncated — ${output.length} chars total]`;
}

export type TaskStatus = "running" | "completed" | "failed";

export interface TaskInfo {
  id: string;
  workspaceId: string;
  chatId: string;
  sessionId?: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  prompt: string;
  maxTurns?: number;
  mode?: string;
  model?: string;
  codingAgentId?: string;
  /**
   * The eventId of the first event broadcast for this task. Set on the
   * first call to broadcast() and used by the SSE endpoint's catch-up
   * replay to scope buffered events to the current task. Without this,
   * a second message in a session would re-yield every event from the
   * prior task that shares the same session buffer.
   */
  firstEventId?: number;
}

/**
 * File attachment metadata to display alongside the user prompt. Stored
 * on the task so the initial `user-message` broadcast can carry the file
 * parts — without these, the session JSONL (and any future reload from
 * it) would render the user's bubble as text-only and lose the images.
 */
export interface DisplayFile {
  mediaType: string;
  url: string;
  filename?: string;
}

export interface SubmitTaskOptions {
  workspaceId: string;
  chatId: string;
  prompt: string;
  sessionId?: string;
  agentPrompt?: string;
  /**
   * Optional file attachments to broadcast as part of the user-message
   * chunk so direct (non-queued) messages survive a session reload with
   * their attached files intact. Each url should already be a stable
   * server-served URL (e.g. /api/uploads/{name}); embedding raw data
   * URLs here is allowed but bloats the persisted JSONL.
   */
  displayFiles?: DisplayFile[];
  maxTurns?: number;
  mode?: string;
  model?: string;
  codingAgentId?: string;
}

/** A UIMessageChunk enriched with a monotonic eventId for gap-fill deduplication. */
export type StreamChunk = UIMessageChunk & { eventId?: number };

type Listener = (chunk: StreamChunk) => void;

/** In-memory ring buffer of broadcast events per session, used for gap-fill replay. */
export interface SessionBuffer {
  events: StreamChunk[];
  counter: number;
}

const MAX_BUFFER_SIZE = 2000;

interface InternalTask extends TaskInfo {
  taskRecordId: string;
  agentPrompt: string;
  displayFiles?: DisplayFile[];
  /**
   * Set when `submitTask` has already broadcast the `user-message` +
   * `task-started` events synchronously (because the task is resuming a
   * known session, so we don't need to wait for the agent's `session-start`
   * to know which buffer to write to). Tells the `session-start` handler
   * in `runTask` to SKIP its own broadcasts of those events — re-emitting
   * would duplicate the user bubble client-side.
   */
  lifecyclePreEmitted?: boolean;
}

// Use globalThis to ensure a single shared state across multiple bundles
// (esbuild start-server.mjs and Vite SSR server.js produce separate copies of this module).
//
// FROZEN STRINGS: the `band.task-runner.*` / `band.pending-inputs` strings
// are the singleton keys. Symbol.for(key) returns the same Symbol across
// modules only when the key string is byte-identical, so renaming any of
// these strings would split the singleton — a running task started by the
// pre-rename module would be invisible to the post-rename one, and the
// dev-time HMR flow this whole block exists to defend against would
// regress. The strings intentionally keep their legacy `task-runner` /
// `pending-inputs` names even though the source files were absorbed into
// this module: they are a keying contract, not a path reference.
const TASKS_KEY = Symbol.for("band.task-runner.tasks");
const LISTENERS_KEY = Symbol.for("band.task-runner.listeners");
const BUFFERS_KEY = Symbol.for("band.task-runner.sessionBuffers");
const USAGE_KEY = Symbol.for("band.task-runner.sessionUsage");
const PENDING_KEY = Symbol.for("band.pending-inputs");

const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[TASKS_KEY]) g[TASKS_KEY] = new Map<string, InternalTask>();
if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Map<string, Set<Listener>>();
if (!g[BUFFERS_KEY]) g[BUFFERS_KEY] = new Map<string, SessionBuffer>();
if (!g[USAGE_KEY]) g[USAGE_KEY] = new Map<string, SessionUsage>();
if (!g[PENDING_KEY]) g[PENDING_KEY] = new Map<string, PendingInput>();

/** Tasks keyed by chatId — one running task per chat pane. */
const tasks = g[TASKS_KEY] as Map<string, InternalTask>;
/** Event listeners keyed by chatId. */
const listeners = g[LISTENERS_KEY] as Map<string, Set<Listener>>;
const sessionBuffers = g[BUFFERS_KEY] as Map<string, SessionBuffer>;
/**
 * Latest token-usage snapshot per session. Survives task completion so the
 * chat UI's context meter still shows accumulated context after the agent
 * stops streaming. Cleared when the session is replaced (session-id-resolved
 * remap) or implicitly when a new chat is created. Stored in-memory only.
 *
 * Bounded by `MAX_SESSION_USAGE` via insertion-order LRU eviction so a
 * long-running server doesn't accumulate per-session entries forever.
 */
const sessionUsage = g[USAGE_KEY] as Map<string, SessionUsage>;
const MAX_SESSION_USAGE = 1000;

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

export interface SessionUsage {
  /** Provider that produced this snapshot. Drives context-size arithmetic. */
  provider?: "claude" | "codex" | "gemini" | "opencode" | "cursor";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
  contextTokens?: number;
  totalProcessedTokens?: number;
  maxContextTokens?: number;
}

// ---------------------------------------------------------------------------
// Pending inputs — `AskUserQuestion` / `ExitPlanMode` approvals
//
// Absorbed from `lib/pending-inputs.ts`. The producer (`onUserInputNeeded`
// inside `runTask`) and the consumer (the chat `answer` mutation) both live
// in this domain.
// ---------------------------------------------------------------------------

interface PendingInput {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
  /** Workspace this approval belongs to — used by hasPendingInputForWorkspace
   *  so the dashboard can keep the "needs attention" indicator on while the
   *  agent is still blocked on user input. May be undefined for legacy
   *  call-sites that didn't pass it. */
  workspaceId?: string;
}

const pendingInputs = g[PENDING_KEY] as Map<string, PendingInput>;

export function createPendingInput(
  approvalId: string,
  workspaceId?: string,
): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    pendingInputs.set(approvalId, { resolve, reject, workspaceId });
  });
}

export function resolvePendingInput(approvalId: string, answers: Record<string, string>): boolean {
  const pending = pendingInputs.get(approvalId);
  if (!pending) return false;
  pendingInputs.delete(approvalId);
  pending.resolve(answers);
  return true;
}

export function rejectPendingInput(approvalId: string, error: Error): boolean {
  const pending = pendingInputs.get(approvalId);
  if (!pending) return false;
  pendingInputs.delete(approvalId);
  pending.reject(error);
  return true;
}

export function rejectAllPendingInputs(error: Error): void {
  for (const [approvalId, pending] of pendingInputs) {
    pendingInputs.delete(approvalId);
    pending.reject(error);
  }
}

/**
 * Returns true if there is at least one pending input request for the given
 * workspace — meaning the agent is currently blocked on a user-facing
 * AskUserQuestion / ExitPlanMode prompt. clearNeedsAttention uses this so the
 * dashboard indicator stays on while the user still owes the agent an answer.
 */
export function hasPendingInputForWorkspace(workspaceId: string): boolean {
  for (const pending of pendingInputs.values()) {
    if (pending.workspaceId === workspaceId) return true;
  }
  return false;
}

function persistTask(task: InternalTask): void {
  const workspace = workspaceService.resolve(task.workspaceId);
  try {
    taskQueries.save({
      id: task.taskRecordId,
      workspaceId: task.workspaceId,
      project: workspace?.project.name ?? "",
      branch: workspace?.worktree.branch ?? "",
      prompt: task.prompt,
      status: task.status,
      sessionId: task.sessionId,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      maxTurns: task.maxTurns,
      mode: task.mode,
      model: task.model,
      codingAgentId: task.codingAgentId,
      chatId: task.chatId,
    });
  } catch (err) {
    log.warn({ err, taskId: task.taskRecordId }, "failed to persist task");
  }
}

function broadcast(chatId: string, chunk: UIMessageChunk) {
  const task = tasks.get(chatId);
  let enrichedChunk: StreamChunk = chunk;

  // Buffer the event in-memory for gap-fill replay
  if (task?.sessionId) {
    let buf = sessionBuffers.get(task.sessionId);
    if (!buf) {
      buf = { events: [], counter: 0 };
      sessionBuffers.set(task.sessionId, buf);
    }
    const eventId = ++buf.counter;
    enrichedChunk = { ...chunk, eventId };
    buf.events.push(enrichedChunk);
    if (buf.events.length > MAX_BUFFER_SIZE) {
      buf.events.shift();
    }
    if (task.firstEventId === undefined) {
      task.firstEventId = eventId;
    }
  }

  const subs = listeners.get(chatId);
  if (!subs || subs.size === 0) {
    log.warn({ chatId, chunkType: (chunk as { type?: string }).type }, "broadcast: no listeners");
    return;
  }
  for (const listener of subs) {
    try {
      listener(enrichedChunk);
    } catch {
      // listener may have been removed
    }
  }
}

export function submitTask(options: SubmitTaskOptions): TaskInfo {
  const {
    workspaceId,
    chatId,
    prompt,
    sessionId,
    agentPrompt,
    displayFiles,
    maxTurns,
    mode,
    model,
    codingAgentId,
  } = options;

  const workspace = workspaceService.resolve(workspaceId);
  if (!workspace) {
    throw new WorkspaceNotFoundError(workspaceId);
  }

  const existing = tasks.get(chatId);
  if (existing?.status === "running") {
    throw new TaskConflictError(chatId);
  }

  const taskRecordId = generateTaskId();
  const task: InternalTask = {
    id: taskRecordId,
    workspaceId,
    chatId,
    sessionId,
    status: "running",
    startedAt: Date.now(),
    prompt,
    taskRecordId,
    agentPrompt: agentPrompt ?? prompt,
    displayFiles: displayFiles && displayFiles.length > 0 ? displayFiles : undefined,
    maxTurns,
    mode,
    model,
    codingAgentId,
  };
  tasks.set(chatId, task);
  persistTask(task);

  // Pre-emit `user-message` + `task-started` synchronously when we're
  // resuming a known session. Without this, the queue-drain UX has a
  // visible 1-2 second gap between the previous task completing and the
  // next user bubble + thinking indicator appearing: the late broadcast
  // in runTask's `session-start` handler can't fire until the agent
  // process has spawned and emitted its first event.
  //
  // For NEW sessions (no `sessionId`), we still wait for `session-start`
  // because `broadcast()` only writes to the in-memory buffer when
  // `task.sessionId` is set — and we need the events on the buffer for
  // gap-fill replay on reconnect. The client-side optimistic dispatch in
  // `useChatSubscription.send()` covers the visual gap for the immediate
  // single-message path; only the server-driven queue drain needs this.
  if (sessionId) {
    task.lifecyclePreEmitted = true;
    broadcast(chatId, {
      type: "user-message",
      text: prompt,
      ...(displayFiles && displayFiles.length > 0 && { files: displayFiles }),
    } as unknown as UIMessageChunk);
    broadcast(chatId, {
      type: "task-started",
      taskId: task.taskRecordId,
      agentType: task.codingAgentId,
      model: task.model,
      mode: task.mode,
    } as unknown as UIMessageChunk);
  }

  // Fire-and-forget async execution
  runTask(chatId, task).catch((err) => {
    log.error({ chatId, err }, "task execution failed");
    // Ensure the task is marked as failed and the client is notified even if
    // runTask throws before reaching its own try/catch (e.g. agent creation fails).
    if (task.status === "running") {
      task.status = "failed";
      task.completedAt = Date.now();
      persistTask(task);
      const errMsg = err instanceof Error ? err.message : "Task execution failed";
      broadcast(chatId, { type: "error", errorText: errMsg });
      broadcast(chatId, { type: "finish" });
      broadcast(chatId, {
        type: "task-error",
        taskId: task.taskRecordId,
        message: errMsg,
      } as unknown as UIMessageChunk);
      chatService.updateStatus(chatId, "error");
    }
  });

  return toTaskInfo(task);
}

export function abortTask(chatId: string): boolean {
  const task = tasks.get(chatId);
  if (!task || task.status !== "running") {
    return false;
  }

  // Reject any pending user-input promises so the agent adapter doesn't hang.
  rejectAllPendingInputs(new Error("Task aborted by user"));

  const agent = getAgent(chatId);
  if (agent?.abort) {
    agent.abort();
  }

  task.status = "failed";
  task.completedAt = Date.now();
  persistTask(task);
  broadcast(chatId, { type: "error", errorText: "Task aborted by user" });
  broadcast(chatId, { type: "finish" });
  broadcast(chatId, {
    type: "task-error",
    taskId: task.taskRecordId,
    message: "Task aborted by user",
  } as unknown as UIMessageChunk);
  tasks.delete(chatId);

  chatService.updateStatus(chatId, "idle");

  const updated = upsertWorkspaceStatus(task.workspaceId, { status: "waiting" });
  emitStatusEvent({ kind: "update", status: updated });

  log.info({ chatId }, "task aborted by user");
  return true;
}

export function cancelTask(taskId: string): { cancelled: boolean; workspaceId?: string } {
  // Search in-memory tasks for a running task with this record ID
  for (const [chatId, task] of tasks) {
    if (task.taskRecordId === taskId && task.status === "running") {
      rejectAllPendingInputs(new Error("Task cancelled"));

      const agent = getAgent(chatId);
      if (agent?.abort) {
        agent.abort();
      }

      task.status = "failed";
      task.completedAt = Date.now();
      persistTask(task);
      broadcast(chatId, { type: "error", errorText: "Task cancelled" });
      broadcast(chatId, { type: "finish" });
      broadcast(chatId, {
        type: "task-error",
        taskId: task.taskRecordId,
        message: "Task cancelled",
      } as unknown as UIMessageChunk);
      tasks.delete(chatId);

      chatService.updateStatus(chatId, "idle");

      const updated = upsertWorkspaceStatus(task.workspaceId, { status: "waiting" });
      emitStatusEvent({ kind: "update", status: updated });

      log.info({ chatId, taskId }, "task cancelled (was running in-memory)");
      return { cancelled: true, workspaceId: task.workspaceId };
    }
  }

  // Not found in memory — try marking the persisted record as failed (orphaned task)
  const record = taskQueries.markFailed(taskId);
  if (record) {
    const updated = upsertWorkspaceStatus(record.workspaceId, { status: "waiting" });
    emitStatusEvent({ kind: "update", status: updated });
    log.info({ taskId, workspaceId: record.workspaceId }, "orphaned task cancelled");
    return { cancelled: true, workspaceId: record.workspaceId };
  }

  return { cancelled: false };
}

async function runTask(chatId: string, task: InternalTask) {
  const workspace = workspaceService.resolve(task.workspaceId);
  if (!workspace) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    broadcast(chatId, { type: "error", errorText: "Workspace not found" });
    tasks.delete(chatId);
    chatService.updateStatus(chatId, "error");
    return;
  }

  // Resolve agent from chat pane config, with task-level override.
  // Only replace the agent when the requested type actually differs from
  // the chat record's agent — otherwise reuse the existing pool entry.
  // This avoids aborting/recreating the agent process on every message
  // which was breaking non-default agents (OpenCode, Codex).
  const chatSession = chatService.get(chatId);
  const taskAgentId = task.codingAgentId;
  const resolvedAgentId = taskAgentId ?? chatSession?.agent;
  const needsReplace = taskAgentId && taskAgentId !== chatSession?.agent;
  log.info(
    { chatId, taskAgentId, chatAgent: chatSession?.agent, resolvedAgentId, needsReplace },
    "resolving agent for task",
  );
  const agent = needsReplace
    ? await replaceAgent(chatId, workspace.worktree.path, taskAgentId)
    : await getOrCreateAgent(chatId, workspace.worktree.path, resolvedAgentId);

  // Mark chat pane as running
  chatService.updateStatus(chatId, "running");

  // Mark workspace as working now that the agent is ready
  const working = upsertWorkspaceStatus(task.workspaceId, { status: "working" });
  emitStatusEvent({ kind: "update", status: working });

  // Per-workspace shared directory so concurrent tasks don't collide.
  const sharedDir = join(bandHome(), "shared", task.workspaceId);
  mkdirSync(sharedDir, { recursive: true });

  /** Tools that require user interaction — their tool-input-available broadcast
   * is handled exclusively by onUserInputNeeded (which enriches the input). */
  const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

  let textPartId = "";
  let textStarted = false;
  let finished = false;
  const announcedToolCalls = new Set<string>();
  /** Files already emitted — avoids re-broadcasting files from earlier tasks. */
  const emittedSharedFiles = listFiles(sharedDir);

  function endText() {
    if (textStarted) {
      broadcast(chatId, { type: "text-end", id: textPartId });
      textStarted = false;
    }
  }

  agent.onUserInputNeeded = async (request) => {
    // End any in-progress text block so the approval card renders below it.
    endText();

    // Always broadcast the interactive tool call with the enriched input so
    // the UI can render the approval component immediately. This is the
    // authoritative broadcast for interactive tools — the tool-use event
    // handler deliberately skips broadcasting for these tools to avoid a
    // race where the tool-use handler broadcasts first with empty input
    // ({}) and then this callback's enriched input (with plan content etc.)
    // is skipped because announcedToolCalls already has the ID.
    announcedToolCalls.add(request.toolCallId);
    broadcast(chatId, {
      type: "tool-input-available",
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      input: request.input,
    });

    // Set status to needs_attention while waiting for user input
    const needsAttention = upsertWorkspaceStatus(task.workspaceId, { status: "needs_attention" });
    emitStatusEvent({ kind: "update", status: needsAttention });

    const answers = await createPendingInput(request.approvalId, task.workspaceId);

    // Restore working status after user responds
    const restored = upsertWorkspaceStatus(task.workspaceId, { status: "working" });
    emitStatusEvent({ kind: "update", status: restored });

    return answers;
  };

  try {
    const sessionOptions =
      task.maxTurns || task.mode || task.model
        ? {
            ...(task.maxTurns && { maxTurns: task.maxTurns }),
            ...(task.mode && { mode: task.mode }),
            ...(task.model && { model: task.model }),
          }
        : undefined;
    // Append file-sharing hint so the agent knows it can send files to the user.
    // Only on the first message — resumed sessions already have the context.
    const fileSharingHint = `\n\n[File sharing: to send a file to the user, write or copy it to ${sharedDir}/ and it will appear as a downloadable file card in the chat.]`;
    const effectivePrompt = task.sessionId ? task.agentPrompt : task.agentPrompt + fileSharingHint;
    for await (const event of agent.runSession(effectivePrompt, task.sessionId, sessionOptions)) {
      log.info({ chatId, eventType: event.type }, "task event");

      switch (event.type) {
        case "session-start": {
          task.sessionId = event.sessionId;
          persistTask(task);

          // Persist the active session + a best-effort initial summary on
          // the chat row so a page refresh between session creation and
          // the client's setActiveSession call still renders the right
          // tab title. The user's prompt is the natural summary for a
          // brand-new session — it's what the CLI's /resume picker shows
          // and what listSessions would return once the JSONL contains a
          // last-prompt record.
          chatService.updateActiveSession(chatId, {
            activeSessionId: event.sessionId,
            summary: task.prompt,
            lastModified: Date.now(),
          });

          broadcast(chatId, {
            type: "data-session" as UIMessageChunk["type"],
            data: { sessionId: event.sessionId },
          } as UIMessageChunk);
          // Broadcast the user's prompt + task-started AFTER session-start
          // so they're buffered against the resolved sessionId and
          // therefore replayable on reconnect. Skipped when `submitTask`
          // already pre-emitted them synchronously (resumed sessions, see
          // `lifecyclePreEmitted`): re-emitting would duplicate the user
          // bubble client-side. Include any uploaded file metadata so
          // reloading the session from the JSONL re-renders the user
          // bubble with its images.
          if (!task.lifecyclePreEmitted) {
            broadcast(chatId, {
              type: "user-message",
              text: task.prompt,
              ...(task.displayFiles &&
                task.displayFiles.length > 0 && {
                  files: task.displayFiles,
                }),
            } as unknown as UIMessageChunk);
            broadcast(chatId, {
              type: "task-started",
              taskId: task.taskRecordId,
              agentType: task.codingAgentId,
              model: task.model,
              mode: task.mode,
            } as unknown as UIMessageChunk);
          }
          break;
        }

        case "text-delta": {
          if (!textStarted) {
            textPartId = crypto.randomUUID();
            broadcast(chatId, { type: "text-start", id: textPartId });
            textStarted = true;
          }
          broadcast(chatId, {
            type: "text-delta",
            id: textPartId,
            delta: event.text,
          });
          break;
        }

        case "text-end": {
          // Adapter-driven block boundary. Used by the Claude Code adapter
          // (with `includePartialMessages: true`) to close the current
          // streaming text bubble when the SDK signals a content_block_start
          // for a non-text block — so a `text → tool_use → text` turn renders
          // as two distinct bubbles around the tool, not one glued bubble.
          // Adapters that don't stream tokens never emit this and the
          // existing side-effect endText() (on tool-use / file / etc.) keeps
          // working unchanged.
          endText();
          break;
        }

        case "tool-use": {
          endText();
          announcedToolCalls.add(event.toolCallId);
          // Interactive tools (ExitPlanMode, AskUserQuestion) are broadcast
          // from onUserInputNeeded which has the enriched input. Skip here
          // to avoid broadcasting with raw/empty input that would either
          // race with or overwrite the enriched broadcast.
          if (!INTERACTIVE_TOOLS.has(event.toolName)) {
            broadcast(chatId, {
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
              ...(event.displayTitle ? { title: event.displayTitle } : {}),
            });
          }
          break;
        }

        case "tool-result": {
          if (!announcedToolCalls.has(event.toolCallId)) {
            endText();
            broadcast(chatId, {
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? "tool",
              input: {},
            });
            announcedToolCalls.add(event.toolCallId);
          }
          const truncated = truncateToolOutput(event.output);
          broadcast(chatId, {
            type: "tool-output-available",
            toolCallId: event.toolCallId,
            output: truncated,
          });

          // Scan workspace shared dir for new files after every successful tool call.
          // The dir is per-workspace so it's always small — scanning is negligible.
          if (!event.isError) {
            for (const filename of listFiles(sharedDir)) {
              if (!emittedSharedFiles.has(filename)) {
                emittedSharedFiles.add(filename);
                broadcast(chatId, {
                  type: "file",
                  mediaType: mimeTypeFromFilename(filename),
                  url: `/api/shared/${encodeURIComponent(task.workspaceId)}/${encodeURIComponent(filename)}`,
                  filename,
                } as UIMessageChunk);
              }
            }
          }
          break;
        }

        case "file": {
          endText();
          broadcast(chatId, {
            type: "file",
            mediaType: event.mediaType,
            url: event.url,
            ...(event.filename ? { filename: event.filename } : {}),
          } as UIMessageChunk);
          break;
        }

        case "usage": {
          // Persist the latest usage for this session so the UI can re-hydrate
          // the context meter after the task completes or the page reloads.
          // Prefer monotonic totalProcessedTokens when available. That lets
          // current context shrink after compaction while still ignoring older
          // replayed snapshots. Older providers fall back to a context high
          // water mark.
          if (task.sessionId) {
            const prev = sessionUsage.get(task.sessionId);
            const shouldStore =
              prev?.totalProcessedTokens !== undefined && event.totalProcessedTokens !== undefined
                ? event.totalProcessedTokens >= prev.totalProcessedTokens
                : usageContextSize(event) >= usageContextSize(prev);
            if (shouldStore) {
              lruSet(
                sessionUsage,
                task.sessionId,
                {
                  provider: event.provider,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  cacheReadTokens: event.cacheReadTokens,
                  cacheCreationTokens: event.cacheCreationTokens,
                  reasoningOutputTokens: event.reasoningOutputTokens,
                  contextTokens: event.contextTokens,
                  totalProcessedTokens: event.totalProcessedTokens,
                  maxContextTokens: event.maxContextTokens,
                },
                MAX_SESSION_USAGE,
              );
            }
          }

          // The Reports dialog reads usage / cost from the provider's
          // on-disk session file via the periodic scanner
          // (`infra/usage-scanner/`, issue #425) — no live capture
          // here. The chat-view context meter is still driven by the
          // `data-usage` broadcast below.
          broadcast(chatId, {
            type: "data-usage" as UIMessageChunk["type"],
            data: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              ...(event.provider !== undefined && { provider: event.provider }),
              ...(event.cacheReadTokens !== undefined && {
                cacheReadTokens: event.cacheReadTokens,
              }),
              ...(event.cacheCreationTokens !== undefined && {
                cacheCreationTokens: event.cacheCreationTokens,
              }),
              ...(event.reasoningOutputTokens !== undefined && {
                reasoningOutputTokens: event.reasoningOutputTokens,
              }),
              ...(event.contextTokens !== undefined && {
                contextTokens: event.contextTokens,
              }),
              ...(event.totalProcessedTokens !== undefined && {
                totalProcessedTokens: event.totalProcessedTokens,
              }),
              ...(event.maxContextTokens !== undefined && {
                maxContextTokens: event.maxContextTokens,
              }),
            },
          } as UIMessageChunk);
          break;
        }

        case "session-result": {
          endText();

          if (event.success) {
            task.status = "completed";
            task.completedAt = Date.now();
            persistTask(task);

            // Reports usage capture is decoupled from this path on
            // purpose (issue #425): the `usage_events` table is filled
            // by the periodic scanner in `infra/usage-scanner/`, and
            // the `reports.summary` tRPC handler triggers a fresh
            // tick on every read. Keeping `task-service` ignorant of
            // the Reports feature means we don't accrete a new
            // `case "session-result":` side-effect for each future
            // session-consumer.

            broadcast(chatId, {
              type: "data-result" as UIMessageChunk["type"],
              data: {
                sessionId: event.sessionId,
                durationMs: event.durationMs,
                numTurns: event.numTurns,
                ...(agent.supportedFeatures.costTracking && {
                  costUsd: event.costUsd,
                }),
              },
            } as UIMessageChunk);
            broadcast(chatId, { type: "finish-step" });
            broadcast(chatId, { type: "finish" });
            // Lifecycle marker for chat-events stream — distinct from the
            // SDK-protocol `finish`/`finish-step` events. Carries task
            // metadata for the reducer to derive `status: completed`.
            broadcast(chatId, {
              type: "task-completed",
              taskId: task.taskRecordId,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
              ...(agent.supportedFeatures.costTracking && { costUsd: event.costUsd }),
            } as unknown as UIMessageChunk);
            finished = true;
          } else {
            task.status = "failed";
            task.completedAt = Date.now();
            persistTask(task);
            const errMsg = `Agent error: ${event.errors.join(", ") || "unknown error"}`;
            broadcast(chatId, { type: "error", errorText: errMsg });
            broadcast(chatId, { type: "finish" });
            broadcast(chatId, {
              type: "task-error",
              taskId: task.taskRecordId,
              message: errMsg,
            } as unknown as UIMessageChunk);
            finished = true;
          }
          break;
        }

        case "session-id-resolved": {
          // The agent resolved its real session ID (e.g. OpenCode discovered
          // its internal ID after the run). Update the task and session buffer
          // so future operations use the real ID.
          log.info(
            { chatId, previous: event.previousSessionId, resolved: event.resolvedSessionId },
            "session ID resolved",
          );

          // Migrate the in-memory session buffer to the new key so that
          // gap-fill replay and sessions.messages can find the events.
          const oldBuf = sessionBuffers.get(event.previousSessionId);
          if (oldBuf) {
            sessionBuffers.set(event.resolvedSessionId, oldBuf);
            sessionBuffers.delete(event.previousSessionId);
          }

          // Migrate the latest usage snapshot too, so the context meter
          // survives the ID swap.
          const oldUsage = sessionUsage.get(event.previousSessionId);
          if (oldUsage) {
            lruSet(sessionUsage, event.resolvedSessionId, oldUsage, MAX_SESSION_USAGE);
            sessionUsage.delete(event.previousSessionId);
          }

          if (task.sessionId === event.previousSessionId) {
            task.sessionId = event.resolvedSessionId;
            persistTask(task);
          }
          // Notify the client so it can update its local session reference
          broadcast(chatId, {
            type: "data-session" as UIMessageChunk["type"],
            data: { sessionId: event.resolvedSessionId },
          } as UIMessageChunk);
          break;
        }

        case "error": {
          broadcast(chatId, {
            type: "error",
            errorText: event.message,
          });
          break;
        }
      }
    }

    endText();

    if (!finished) {
      if (task.status === "running") {
        task.status = "completed";
        task.completedAt = Date.now();
      }
      persistTask(task);
      const errMsg = "Agent session ended without producing a result";
      broadcast(chatId, { type: "error", errorText: errMsg });
      broadcast(chatId, { type: "finish" });
      broadcast(chatId, {
        type: "task-error",
        taskId: task.taskRecordId,
        message: errMsg,
      } as unknown as UIMessageChunk);
    }
  } catch (err) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    broadcast(chatId, { type: "error", errorText: errMsg });
    broadcast(chatId, { type: "finish" });
    broadcast(chatId, {
      type: "task-error",
      taskId: task.taskRecordId,
      message: errMsg,
    } as unknown as UIMessageChunk);
    chatService.updateStatus(chatId, "error");
  }

  // Auto-start a new task if there's a queued message and the task succeeded.
  // Under the chat-events stream the drained turn is surfaced by the
  // follow-up task's `user-message` (session-start) event — no need to
  // emit a separate "user bubble" chunk here. See `docs/experiments/chat-event-log.md`.
  let autoStarted = false;
  if (task.status === "completed") {
    const queued = shiftQueuedMessage(chatId);
    if (queued) {
      try {
        // Queued payloads already carry display-file metadata (saved to
        // disk by the submit handler before being queued). Rebuild the
        // agent prompt and display-files arrays directly from the
        // queued metadata — DO NOT call `saveUploadedFilesDetailed`
        // again: by the time the file landed on the queue its URL had
        // already been transformed from a `data:` URL into
        // `/api/uploads/<storedName>`, and the helper's data-URL regex
        // would silently skip every file (the bug this fixes).
        //
        // The `path` field on `QueuedFile` is what makes this safe to
        // do without a second save: every enqueue site is responsible
        // for persisting bytes first and forwarding the absolute path
        // through. See `apps/web/src/lib/queued-message-store.ts`.
        let agentPrompt: string | undefined;
        let displayFiles: DisplayFile[] | undefined;
        if (queued.files && queued.files.length > 0) {
          // Defensive filter: drop any queued file whose path didn't
          // make it through the resolve step (empty string sentinel).
          // The tRPC `resolveQueuedFiles` should never let an empty
          // path through to the store, but if a future regression
          // does, injecting `- ` into the agent prompt would just
          // make the agent fail to read a file at "" — better to
          // skip silently with the rest of the prompt intact.
          const usableFiles = queued.files.filter((f) => f.path);
          if (usableFiles.length > 0) {
            const fileList = usableFiles.map((f) => `- ${f.path}`).join("\n");
            agentPrompt = `I'm sharing these files with you:\n${fileList}\n\n${queued.text}`;
            displayFiles = usableFiles.map((f) => ({
              mediaType: f.mediaType,
              url: f.url,
              filename: f.filename,
            }));
          }
        }

        submitTask({
          workspaceId: task.workspaceId,
          chatId,
          prompt: queued.text,
          agentPrompt,
          sessionId: task.sessionId,
          displayFiles,
        });
        autoStarted = true;
      } catch (err) {
        log.warn({ chatId, err }, "failed to auto-start queued task");
      }
    }
  }

  // Update chat pane and workspace status
  if (!autoStarted) {
    chatService.updateStatus(chatId, "idle");
    const endStatus = task.status === "completed" ? "needs_attention" : "waiting";
    const updated = upsertWorkspaceStatus(task.workspaceId, { status: endStatus });
    emitStatusEvent({ kind: "update", status: updated });
  }
}

export function getTask(chatId: string): TaskInfo | null {
  const task = tasks.get(chatId);
  if (!task) return null;
  return toTaskInfo(task);
}

/**
 * List persisted task rows. Service-tier façade over `TaskQueries.list`
 * so the API tier never reaches into infra directly (per the API → Service
 * → Infra dependency direction in `docs/web-architecture.md`).
 */
export function listTaskRecords(filters?: Parameters<TaskQueries["list"]>[0]) {
  return taskQueries.list(filters);
}

/**
 * Load a single persisted task row by id. Service-tier façade over
 * `TaskQueries.load`. Returns `null` when no row matches.
 */
export function loadTaskRecord(id: string) {
  return taskQueries.load(id);
}

/**
 * Get the in-memory event buffer for a session.
 * Used by the chat-events stream for gap-fill replay and message conversion.
 */
export function getSessionBuffer(sessionId: string): SessionBuffer | undefined {
  return sessionBuffers.get(sessionId);
}

/**
 * Compute context size for monotonic comparison only (not for display). Used
 * by the SSE replay guard that throws away stale chunks. Adapters are
 * expected to populate `contextTokens` directly; the summation fallback is
 * provider-aware: `cacheCreationTokens` is Claude-only, so its presence
 * signals Claude semantics where `inputTokens` excludes cached content.
 */
function usageContextSize(usage: SessionUsage | undefined): number {
  if (!usage) return 0;
  if (usage.contextTokens !== undefined) return usage.contextTokens;
  // Provider-driven legacy fallback. Claude `inputTokens` excludes cached
  // content → must add cache fields. Other providers report full prompt.
  // Pre-provider snapshots use `cacheCreationTokens` presence as a
  // backward-compatible Claude detector.
  const isClaude = usage.provider === "claude" || usage.cacheCreationTokens !== undefined;
  if (isClaude) {
    return (
      usage.inputTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0) +
      (usage.reasoningOutputTokens ?? 0)
    );
  }
  return usage.inputTokens + (usage.reasoningOutputTokens ?? 0);
}

/** Get the latest persisted usage snapshot for a session, if any. */
export function getSessionUsage(sessionId: string): SessionUsage | undefined {
  return sessionUsage.get(sessionId);
}

export function subscribe(chatId: string, listener: Listener): () => void {
  let subs = listeners.get(chatId);
  if (!subs) {
    subs = new Set();
    listeners.set(chatId, subs);
  }
  subs.add(listener);

  return () => {
    subs.delete(listener);
    if (subs.size === 0) {
      listeners.delete(chatId);
    }
  };
}

function toTaskInfo(task: InternalTask): TaskInfo {
  return {
    id: task.taskRecordId,
    workspaceId: task.workspaceId,
    chatId: task.chatId,
    sessionId: task.sessionId,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    prompt: task.prompt,
    maxTurns: task.maxTurns,
    mode: task.mode,
    model: task.model,
    codingAgentId: task.codingAgentId,
    firstEventId: task.firstEventId,
  };
}

export class TaskConflictError extends Error {
  constructor(chatId: string) {
    super(`Task already running for chat ${chatId}`);
    this.name = "TaskConflictError";
  }
}

/**
 * Re-export of the canonical `WorkspaceNotFoundError` defined in
 * `server/errors.ts` (imported at the top of this file for internal throws).
 * Kept as a re-export so existing callers (the API tier, `lib/chat-submit.ts`)
 * can keep importing it from the service module without an import path churn.
 * The class itself is shared with `session-service` and `workspace-service` —
 * see `errors.ts` for the consolidation rationale.
 */
export { WorkspaceNotFoundError };

// ---------------------------------------------------------------------------
// Session event-buffer accessors (absorbed from `lib/session-store.ts`).
//
// Read helpers over the in-memory ring buffer maintained by `broadcast`
// above. Used by the chat-events stream for gap-fill replay and message
// conversion — they live in the service tier because the buffer they read
// is the task event loop's output.
// ---------------------------------------------------------------------------

/**
 * A buffered session event.
 *
 * Buffered chunks are kept as already-parsed objects so that callers don't
 * pay a JSON.stringify/parse cost on every read. With ring buffers up to
 * MAX_BUFFER_SIZE (2000) entries this loop dominated workspace-switch
 * latency for active sessions.
 */
export interface SessionEventRecord {
  id: number;
  sessionId: string;
  chunkType: string;
  /** The parsed stream chunk. Treat as read-only. */
  chunk: StreamChunk;
  createdAt: number;
}

function chunkToRecord(sessionId: string, chunk: StreamChunk): SessionEventRecord {
  return {
    id: chunk.eventId ?? 0,
    sessionId,
    chunkType: chunk.type,
    chunk,
    createdAt: Date.now(),
  };
}

/**
 * Get the most recent N events for a session (for initial page load).
 * Returns events in ascending id order (oldest first).
 */
export function getSessionEventsTail(sessionId: string, limit: number): SessionEventRecord[] {
  const buf = getSessionBuffer(sessionId);
  if (!buf) return [];
  const start = Math.max(0, buf.events.length - limit);
  return buf.events.slice(start).map((c) => chunkToRecord(sessionId, c));
}

/**
 * Get events before a given eventId for scroll-up pagination.
 * Returns events in ascending id order (oldest first).
 */
export function getSessionEventsBefore(
  sessionId: string,
  beforeEventId: number,
  limit: number,
): SessionEventRecord[] {
  const buf = getSessionBuffer(sessionId);
  if (!buf) return [];
  // Find the index of the first event with id >= beforeEventId
  const cutoff = buf.events.findIndex((e) => (e.eventId ?? 0) >= beforeEventId);
  if (cutoff <= 0) return [];
  const start = Math.max(0, cutoff - limit);
  return buf.events.slice(start, cutoff).map((c) => chunkToRecord(sessionId, c));
}

/**
 * Get events after a given eventId (for gap-fill replay).
 * Returns events in ascending id order.
 */
export function getSessionEventsAfter(
  sessionId: string,
  afterEventId: number,
): SessionEventRecord[] {
  const buf = getSessionBuffer(sessionId);
  if (!buf) return [];
  return buf.events
    .filter((e) => (e.eventId ?? 0) > afterEventId)
    .map((c) => chunkToRecord(sessionId, c));
}

// ---------------------------------------------------------------------------
// Class wrapper (issue #535, follow-up 5)
//
// Routers and other services should depend on `taskService` rather than the
// bare function exports above. The class is a thin façade: every method
// delegates to the corresponding module-level function so the singleton
// in-memory state (`tasks`, `listeners`, `sessionBuffers`, `sessionUsage`,
// `pendingInputs`) — which is held on `globalThis` symbols so it survives
// module re-evaluation in dev (vite/HMR) and across multiple bundles —
// stays in lock-step regardless of how callers reach the API.
//
// The injectable `TaskQueries` dependency lets tests swap in a stubbed
// queries adapter for the persistence-touching methods (`listTaskRecords`,
// `loadTaskRecord`). The function exports above are retained as a
// back-compat surface for callers that already speak the module API; new
// code should use `taskService.method(...)`.
// ---------------------------------------------------------------------------

export class TaskService {
  /**
   * TODO(#535-followup): complete the DI migration for `submitTask` /
   * `abortTask` / `cancelTask` / `getTask` / the session-buffer
   * accessors, mirroring the `ChatService.refreshes` private-field
   * pattern (lazy resolve a `globalThis`-keyed Map into a class
   * member).
   *
   * What `new TaskService(stub)` buys you today: stubbed reads from
   * `listTaskRecords` and `loadTaskRecord`. That's it. The runtime
   * methods (`submitTask`, `abortTask`, `cancelTask`, `getTask`, the
   * session-buffer accessors) all delegate to the module-level
   * functions, which read the module-level `taskQueries` AND the
   * `globalThis`-keyed in-memory state — none of which the injected
   * `queries` reaches. Test authors that need to stub the whole
   * surface should treat the singleton as live infrastructure (start
   * the real server in a test) rather than trying to isolate it via
   * constructor DI alone.
   */
  constructor(private readonly queries: TaskQueries = taskQueries) {}

  createPendingInput(approvalId: string, workspaceId?: string): Promise<Record<string, string>> {
    return createPendingInput(approvalId, workspaceId);
  }

  resolvePendingInput(approvalId: string, answers: Record<string, string>): boolean {
    return resolvePendingInput(approvalId, answers);
  }

  rejectPendingInput(approvalId: string, error: Error): boolean {
    return rejectPendingInput(approvalId, error);
  }

  rejectAllPendingInputs(error: Error): void {
    rejectAllPendingInputs(error);
  }

  hasPendingInputForWorkspace(workspaceId: string): boolean {
    return hasPendingInputForWorkspace(workspaceId);
  }

  submitTask(options: SubmitTaskOptions): TaskInfo {
    return submitTask(options);
  }

  abortTask(chatId: string): boolean {
    return abortTask(chatId);
  }

  cancelTask(taskId: string): { cancelled: boolean; workspaceId?: string } {
    return cancelTask(taskId);
  }

  getTask(chatId: string): TaskInfo | null {
    return getTask(chatId);
  }

  listTaskRecords(filters?: Parameters<TaskQueries["list"]>[0]) {
    return this.queries.list(filters);
  }

  loadTaskRecord(id: string) {
    return this.queries.load(id);
  }

  getSessionBuffer(sessionId: string): SessionBuffer | undefined {
    return getSessionBuffer(sessionId);
  }

  getSessionUsage(sessionId: string): SessionUsage | undefined {
    return getSessionUsage(sessionId);
  }

  subscribe(chatId: string, listener: Listener): () => void {
    return subscribe(chatId, listener);
  }

  getSessionEventsTail(sessionId: string, limit: number): SessionEventRecord[] {
    return getSessionEventsTail(sessionId, limit);
  }

  getSessionEventsBefore(
    sessionId: string,
    beforeEventId: number,
    limit: number,
  ): SessionEventRecord[] {
    return getSessionEventsBefore(sessionId, beforeEventId, limit);
  }

  getSessionEventsAfter(sessionId: string, afterEventId: number): SessionEventRecord[] {
    return getSessionEventsAfter(sessionId, afterEventId);
  }
}

/**
 * Process-wide singleton. Method calls route through the existing
 * module-level functions, which themselves operate on the `globalThis`-
 * keyed state — so multiple bundles or HMR reloads still share a single
 * logical task pool.
 */
export const taskService = new TaskService();
