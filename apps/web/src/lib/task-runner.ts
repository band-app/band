import { createLogger } from "@band/logger";
import type { UIMessageChunk } from "ai";
import { getAgent, getOrCreateAgent } from "./agent-pool";
import { createPendingInput } from "./pending-inputs";
import { generateTaskId, saveTask } from "./task-store";
import { resolveWorkspace } from "./workspace";

const log = createLogger("task-runner");

const MAX_TOOL_OUTPUT_LEN = 10_000;

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LEN) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LEN)}\n\n[output truncated — ${output.length} chars total]`;
}

export type TaskStatus = "running" | "completed" | "failed";

export interface TaskInfo {
  workspaceId: string;
  sessionId?: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  prompt: string;
}

type Listener = (chunk: UIMessageChunk) => void;

interface InternalTask extends TaskInfo {
  taskRecordId: string;
  agentPrompt: string;
  chunks: UIMessageChunk[];
  expireTimer?: ReturnType<typeof setTimeout>;
}

// Use globalThis to ensure a single shared state across multiple bundles
// (esbuild start-server.mjs and Vite SSR server.js produce separate copies of this module)
const TASKS_KEY = Symbol.for("band.task-runner.tasks");
const LISTENERS_KEY = Symbol.for("band.task-runner.listeners");

const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[TASKS_KEY]) g[TASKS_KEY] = new Map<string, InternalTask>();
if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Map<string, Set<Listener>>();

const tasks = g[TASKS_KEY] as Map<string, InternalTask>;
const listeners = g[LISTENERS_KEY] as Map<string, Set<Listener>>;

const BUFFER_EXPIRE_MS = 30 * 60 * 1000; // 30 minutes

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
    });
  } catch (err) {
    log.warn({ err, taskId: task.taskRecordId }, "failed to persist task");
  }
}

function broadcast(workspaceId: string, chunk: UIMessageChunk) {
  const subs = listeners.get(workspaceId);
  if (!subs) return;
  for (const listener of subs) {
    try {
      listener(chunk);
    } catch {
      // listener may have been removed
    }
  }
}

function emit(workspaceId: string, task: InternalTask, chunk: UIMessageChunk) {
  task.chunks.push(chunk);
  broadcast(workspaceId, chunk);
}

export function submitTask(
  workspaceId: string,
  prompt: string,
  sessionId?: string,
  agentPrompt?: string,
): TaskInfo {
  const existing = tasks.get(workspaceId);
  if (existing?.status === "running") {
    throw new TaskConflictError(workspaceId);
  }

  // Clear any previous expiration timer
  if (existing?.expireTimer) {
    clearTimeout(existing.expireTimer);
  }

  const task: InternalTask = {
    workspaceId,
    sessionId,
    status: "running",
    startedAt: Date.now(),
    prompt,
    taskRecordId: generateTaskId(),
    agentPrompt: agentPrompt ?? prompt,
    chunks: [
      // Emit user-facing prompt so reconnecting clients can reconstruct the user message
      { type: "data-prompt", data: { text: prompt } } as UIMessageChunk,
    ],
  };
  tasks.set(workspaceId, task);
  persistTask(task);

  // Fire-and-forget async execution
  runTask(workspaceId, task).catch((err) => {
    log.error({ workspaceId, err }, "task execution failed");
  });

  return toTaskInfo(task);
}

export function abortTask(workspaceId: string): boolean {
  const task = tasks.get(workspaceId);
  if (!task || task.status !== "running") {
    return false;
  }

  const agent = getAgent(workspaceId);
  if (agent?.abort) {
    agent.abort();
  }

  task.status = "failed";
  task.completedAt = Date.now();
  persistTask(task);
  emit(workspaceId, task, { type: "error", errorText: "Task aborted by user" });
  emit(workspaceId, task, { type: "finish" });
  scheduleExpiry(workspaceId);

  log.info({ workspaceId }, "task aborted by user");
  return true;
}

async function runTask(workspaceId: string, task: InternalTask) {
  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    emit(workspaceId, task, { type: "error", errorText: "Workspace not found" });
    scheduleExpiry(workspaceId);
    return;
  }

  const agent = await getOrCreateAgent(workspaceId, workspace.worktree.path);

  agent.onUserInputNeeded = async (request) => {
    return createPendingInput(request.approvalId);
  };

  let textPartId = "";
  let textStarted = false;
  let finished = false;
  const announcedToolCalls = new Set<string>();

  function endText() {
    if (textStarted) {
      emit(workspaceId, task, { type: "text-end", id: textPartId });
      textStarted = false;
    }
  }

  try {
    for await (const event of agent.runSession(task.agentPrompt, task.sessionId)) {
      log.info({ workspaceId, eventType: event.type }, "task event");

      switch (event.type) {
        case "session-start": {
          task.sessionId = event.sessionId;
          persistTask(task);
          emit(workspaceId, task, {
            type: "data-session" as UIMessageChunk["type"],
            data: { sessionId: event.sessionId },
          } as UIMessageChunk);
          break;
        }

        case "text-delta": {
          if (!textStarted) {
            textPartId = crypto.randomUUID();
            emit(workspaceId, task, { type: "text-start", id: textPartId });
            textStarted = true;
          }
          emit(workspaceId, task, {
            type: "text-delta",
            id: textPartId,
            delta: event.text,
          });
          break;
        }

        case "tool-use": {
          endText();
          announcedToolCalls.add(event.toolCallId);
          emit(workspaceId, task, {
            type: "tool-input-available",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          });
          break;
        }

        case "tool-result": {
          if (!announcedToolCalls.has(event.toolCallId)) {
            endText();
            emit(workspaceId, task, {
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: "tool",
              input: {},
            });
            announcedToolCalls.add(event.toolCallId);
          }
          const truncated = truncateToolOutput(event.output);
          emit(workspaceId, task, {
            type: "tool-output-available",
            toolCallId: event.toolCallId,
            output: truncated,
          });
          break;
        }

        case "session-result": {
          endText();

          if (event.success) {
            task.status = "completed";
            task.completedAt = Date.now();
            persistTask(task);
            emit(workspaceId, task, {
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
            emit(workspaceId, task, { type: "finish-step" });
            emit(workspaceId, task, { type: "finish" });
            finished = true;
          } else {
            task.status = "failed";
            task.completedAt = Date.now();
            persistTask(task);
            emit(workspaceId, task, {
              type: "error",
              errorText: `Agent error: ${event.errors.join(", ") || "unknown error"}`,
            });
            finished = true;
          }
          break;
        }

        case "error": {
          emit(workspaceId, task, {
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
      emit(workspaceId, task, {
        type: "error",
        errorText: "Agent session ended without producing a result",
      });
    }
  } catch (err) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    emit(workspaceId, task, {
      type: "error",
      errorText: err instanceof Error ? err.message : "Unknown error",
    });
  }

  scheduleExpiry(workspaceId);
}

function scheduleExpiry(workspaceId: string) {
  const task = tasks.get(workspaceId);
  if (!task) return;
  task.expireTimer = setTimeout(() => {
    const current = tasks.get(workspaceId);
    if (current === task && current.status !== "running") {
      tasks.delete(workspaceId);
    }
  }, BUFFER_EXPIRE_MS);
}

export function getTask(workspaceId: string): TaskInfo | null {
  const task = tasks.get(workspaceId);
  if (!task) return null;
  return toTaskInfo(task);
}

export function subscribe(workspaceId: string, listener: Listener): () => void {
  let subs = listeners.get(workspaceId);
  if (!subs) {
    subs = new Set();
    listeners.set(workspaceId, subs);
  }
  subs.add(listener);

  return () => {
    subs.delete(listener);
    if (subs.size === 0) {
      listeners.delete(workspaceId);
    }
  };
}

export function getBufferedChunks(workspaceId: string): UIMessageChunk[] {
  const task = tasks.get(workspaceId);
  if (!task) return [];
  return [...task.chunks];
}

function toTaskInfo(task: InternalTask): TaskInfo {
  return {
    workspaceId: task.workspaceId,
    sessionId: task.sessionId,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    prompt: task.prompt,
  };
}

export class TaskConflictError extends Error {
  constructor(workspaceId: string) {
    super(`Task already running for workspace ${workspaceId}`);
    this.name = "TaskConflictError";
  }
}
