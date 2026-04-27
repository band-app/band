import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import type { UIMessageChunk } from "ai";
import { getAgent, getOrCreateAgent, replaceAgent } from "./agent-pool";
import { getChat, updateChatStatus } from "./chat-manager";
import { mimeTypeFromFilename } from "./mime-types";
import { createPendingInput, rejectAllPendingInputs } from "./pending-inputs";
import { shiftQueuedMessage } from "./queued-message-store";
import { bandHome, upsertWorkspaceStatus } from "./state";
import { generateTaskId, markTaskFailed, saveTask } from "./task-store";
import { emit as emitStatusEvent } from "./watcher";
import { resolveWorkspace } from "./workspace";

const log = createLogger("task-runner");

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
   * first call to broadcast() and used by tasks.stream Phase 2b catch-up
   * replay to scope buffered events to the current task. Without this,
   * a second message in a session would re-yield every event from the
   * prior task that shares the same session buffer.
   */
  firstEventId?: number;
}

export interface SubmitTaskOptions {
  workspaceId: string;
  chatId: string;
  prompt: string;
  sessionId?: string;
  agentPrompt?: string;
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
}

// Use globalThis to ensure a single shared state across multiple bundles
// (esbuild start-server.mjs and Vite SSR server.js produce separate copies of this module)
const TASKS_KEY = Symbol.for("band.task-runner.tasks");
const LISTENERS_KEY = Symbol.for("band.task-runner.listeners");
const BUFFERS_KEY = Symbol.for("band.task-runner.sessionBuffers");

const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[TASKS_KEY]) g[TASKS_KEY] = new Map<string, InternalTask>();
if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Map<string, Set<Listener>>();
if (!g[BUFFERS_KEY]) g[BUFFERS_KEY] = new Map<string, SessionBuffer>();

/** Tasks keyed by chatId — one running task per chat pane. */
const tasks = g[TASKS_KEY] as Map<string, InternalTask>;
/** Event listeners keyed by chatId. */
const listeners = g[LISTENERS_KEY] as Map<string, Set<Listener>>;
const sessionBuffers = g[BUFFERS_KEY] as Map<string, SessionBuffer>;

function persistTask(task: InternalTask): void {
  const workspace = resolveWorkspace(task.workspaceId);
  try {
    saveTask({
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
    maxTurns,
    mode,
    model,
    codingAgentId,
  } = options;

  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
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
    maxTurns,
    mode,
    model,
    codingAgentId,
  };
  tasks.set(chatId, task);
  persistTask(task);

  // Fire-and-forget async execution
  runTask(chatId, task).catch((err) => {
    log.error({ chatId, err }, "task execution failed");
    // Ensure the task is marked as failed and the client is notified even if
    // runTask throws before reaching its own try/catch (e.g. agent creation fails).
    if (task.status === "running") {
      task.status = "failed";
      task.completedAt = Date.now();
      persistTask(task);
      broadcast(chatId, {
        type: "error",
        errorText: err instanceof Error ? err.message : "Task execution failed",
      });
      broadcast(chatId, { type: "finish" });
      updateChatStatus(chatId, "error");
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
  tasks.delete(chatId);

  updateChatStatus(chatId, "idle");

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
      tasks.delete(chatId);

      updateChatStatus(chatId, "idle");

      const updated = upsertWorkspaceStatus(task.workspaceId, { status: "waiting" });
      emitStatusEvent({ kind: "update", status: updated });

      log.info({ chatId, taskId }, "task cancelled (was running in-memory)");
      return { cancelled: true, workspaceId: task.workspaceId };
    }
  }

  // Not found in memory — try marking the persisted record as failed (orphaned task)
  const record = markTaskFailed(taskId);
  if (record) {
    const updated = upsertWorkspaceStatus(record.workspaceId, { status: "waiting" });
    emitStatusEvent({ kind: "update", status: updated });
    log.info({ taskId, workspaceId: record.workspaceId }, "orphaned task cancelled");
    return { cancelled: true, workspaceId: record.workspaceId };
  }

  return { cancelled: false };
}

async function runTask(chatId: string, task: InternalTask) {
  const workspace = resolveWorkspace(task.workspaceId);
  if (!workspace) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    broadcast(chatId, { type: "error", errorText: "Workspace not found" });
    tasks.delete(chatId);
    updateChatStatus(chatId, "error");
    return;
  }

  // Resolve agent from chat pane config, with task-level override.
  // Only replace the agent when the requested type actually differs from
  // the chat record's agent — otherwise reuse the existing pool entry.
  // This avoids aborting/recreating the agent process on every message
  // which was breaking non-default agents (OpenCode, Codex).
  const chatSession = getChat(chatId);
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
  updateChatStatus(chatId, "running");

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

    const answers = await createPendingInput(request.approvalId);

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
          broadcast(chatId, {
            type: "data-session" as UIMessageChunk["type"],
            data: { sessionId: event.sessionId },
          } as UIMessageChunk);
          // Broadcast the user's prompt AFTER session-start so task.sessionId
          // is set and broadcast() stores it in the session buffer.
          // Uses "user-message" (not "data-prompt") so the live stream ignores
          // it — useChat already has the user message in its state.
          broadcast(chatId, {
            type: "user-message",
            text: task.prompt,
          } as unknown as UIMessageChunk);
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

        case "session-result": {
          endText();

          if (event.success) {
            task.status = "completed";
            task.completedAt = Date.now();
            persistTask(task);
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
            finished = true;
          } else {
            task.status = "failed";
            task.completedAt = Date.now();
            persistTask(task);
            broadcast(chatId, {
              type: "error",
              errorText: `Agent error: ${event.errors.join(", ") || "unknown error"}`,
            });
            broadcast(chatId, { type: "finish" });
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
      broadcast(chatId, {
        type: "error",
        errorText: "Agent session ended without producing a result",
      });
      broadcast(chatId, { type: "finish" });
    }
  } catch (err) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    broadcast(chatId, {
      type: "error",
      errorText: err instanceof Error ? err.message : "Unknown error",
    });
    broadcast(chatId, { type: "finish" });
    updateChatStatus(chatId, "error");
  }

  // Auto-start a new task if there's a queued message and the task succeeded
  let autoStarted = false;
  if (task.status === "completed") {
    const queued = shiftQueuedMessage(chatId);
    if (queued) {
      try {
        // Emit the queued user prompt so the client can render it as a
        // user message bubble between assistant responses.
        broadcast(chatId, {
          type: "data-prompt" as UIMessageChunk["type"],
          data: { text: queued },
        } as UIMessageChunk);
        submitTask({
          workspaceId: task.workspaceId,
          chatId,
          prompt: queued,
          sessionId: task.sessionId,
        });
        autoStarted = true;
      } catch (err) {
        log.warn({ chatId, err }, "failed to auto-start queued task");
      }
    }
  }

  // Update chat pane and workspace status
  if (!autoStarted) {
    updateChatStatus(chatId, "idle");
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
 * Get the in-memory event buffer for a session.
 * Used by the tRPC router for gap-fill replay and message conversion.
 */
export function getSessionBuffer(sessionId: string): SessionBuffer | undefined {
  return sessionBuffers.get(sessionId);
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
