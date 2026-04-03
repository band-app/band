import { createLogger } from "@band-app/logger";
import type { UIMessageChunk } from "ai";
import { getAgent, getOrCreateAgent } from "./agent-pool";
import { createPendingInput } from "./pending-inputs";
import { shiftQueuedMessage } from "./queued-message-store";
import { getWorkspaceStatus, upsertWorkspaceStatus } from "./state";
import { generateTaskId, markTaskFailed, saveTask } from "./task-store";
import { emit as emitStatusEvent } from "./watcher";
import { resolveWorkspace } from "./workspace";

const log = createLogger("task-runner");

const MAX_TOOL_OUTPUT_LEN = 10_000;

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LEN) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LEN)}\n\n[output truncated — ${output.length} chars total]`;
}

export type TaskStatus = "running" | "completed" | "failed";

export interface TaskInfo {
  id: string;
  workspaceId: string;
  sessionId?: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  prompt: string;
  maxTurns?: number;
  mode?: string;
  model?: string;
}

type Listener = (chunk: UIMessageChunk) => void;

interface InternalTask extends TaskInfo {
  taskRecordId: string;
  agentPrompt: string;
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

export function submitTask(
  workspaceId: string,
  prompt: string,
  sessionId?: string,
  agentPrompt?: string,
  maxTurns?: number,
  mode?: string,
  model?: string,
): TaskInfo {
  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const existing = tasks.get(workspaceId);
  if (existing?.status === "running") {
    throw new TaskConflictError(workspaceId);
  }

  const taskRecordId = generateTaskId();
  const task: InternalTask = {
    id: taskRecordId,
    workspaceId,
    sessionId,
    status: "running",
    startedAt: Date.now(),
    prompt,
    taskRecordId,
    agentPrompt: agentPrompt ?? prompt,
    maxTurns,
    mode,
    model,
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
  broadcast(workspaceId, { type: "error", errorText: "Task aborted by user" });
  broadcast(workspaceId, { type: "finish" });
  tasks.delete(workspaceId);

  log.info({ workspaceId }, "task aborted by user");
  return true;
}

export function cancelTask(taskId: string): { cancelled: boolean; workspaceId?: string } {
  // Search in-memory tasks for a running task with this record ID
  for (const [workspaceId, task] of tasks) {
    if (task.taskRecordId === taskId && task.status === "running") {
      const agent = getAgent(workspaceId);
      if (agent?.abort) {
        agent.abort();
      }

      task.status = "failed";
      task.completedAt = Date.now();
      persistTask(task);
      broadcast(workspaceId, { type: "error", errorText: "Task cancelled" });
      broadcast(workspaceId, { type: "finish" });
      tasks.delete(workspaceId);

      log.info({ workspaceId, taskId }, "task cancelled (was running in-memory)");
      return { cancelled: true, workspaceId };
    }
  }

  // Not found in memory — try marking the persisted record as failed (orphaned task)
  const record = markTaskFailed(taskId);
  if (record) {
    log.info({ taskId, workspaceId: record.workspaceId }, "orphaned task cancelled");
    return { cancelled: true, workspaceId: record.workspaceId };
  }

  return { cancelled: false };
}

async function runTask(workspaceId: string, task: InternalTask) {
  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    broadcast(workspaceId, { type: "error", errorText: "Workspace not found" });
    tasks.delete(workspaceId);
    return;
  }

  // Look up the workspace's preferred coding agent from the DB status
  const wsStatus = getWorkspaceStatus(workspaceId);
  const codingAgentId = wsStatus?.agent?.codingAgentId;
  const agent = await getOrCreateAgent(workspaceId, workspace.worktree.path, codingAgentId);

  // Mark workspace as working now that the agent is ready
  const working = upsertWorkspaceStatus(workspaceId, { status: "working" });
  emitStatusEvent({ kind: "update", status: working });

  agent.onUserInputNeeded = async (request) => {
    // Set status to needs_attention while waiting for user input
    const needsAttention = upsertWorkspaceStatus(workspaceId, { status: "needs_attention" });
    emitStatusEvent({ kind: "update", status: needsAttention });

    const answers = await createPendingInput(request.approvalId);

    // Restore working status after user responds
    const restored = upsertWorkspaceStatus(workspaceId, { status: "working" });
    emitStatusEvent({ kind: "update", status: restored });

    return answers;
  };

  let textPartId = "";
  let textStarted = false;
  let finished = false;
  const announcedToolCalls = new Set<string>();

  function endText() {
    if (textStarted) {
      broadcast(workspaceId, { type: "text-end", id: textPartId });
      textStarted = false;
    }
  }

  try {
    const sessionOptions =
      task.maxTurns || task.mode || task.model
        ? {
            ...(task.maxTurns && { maxTurns: task.maxTurns }),
            ...(task.mode && { mode: task.mode }),
            ...(task.model && { model: task.model }),
          }
        : undefined;
    for await (const event of agent.runSession(task.agentPrompt, task.sessionId, sessionOptions)) {
      log.info({ workspaceId, eventType: event.type }, "task event");

      switch (event.type) {
        case "session-start": {
          task.sessionId = event.sessionId;
          persistTask(task);
          broadcast(workspaceId, {
            type: "data-session" as UIMessageChunk["type"],
            data: { sessionId: event.sessionId },
          } as UIMessageChunk);
          break;
        }

        case "text-delta": {
          if (!textStarted) {
            textPartId = crypto.randomUUID();
            broadcast(workspaceId, { type: "text-start", id: textPartId });
            textStarted = true;
          }
          broadcast(workspaceId, {
            type: "text-delta",
            id: textPartId,
            delta: event.text,
          });
          break;
        }

        case "tool-use": {
          endText();
          announcedToolCalls.add(event.toolCallId);
          broadcast(workspaceId, {
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
            broadcast(workspaceId, {
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? "tool",
              input: {},
            });
            announcedToolCalls.add(event.toolCallId);
          }
          const truncated = truncateToolOutput(event.output);
          broadcast(workspaceId, {
            type: "tool-output-available",
            toolCallId: event.toolCallId,
            output: truncated,
          });
          break;
        }

        case "file": {
          endText();
          broadcast(workspaceId, {
            type: "file",
            mediaType: event.mediaType,
            url: event.url,
          });
          break;
        }

        case "session-result": {
          endText();

          if (event.success) {
            task.status = "completed";
            task.completedAt = Date.now();
            persistTask(task);
            broadcast(workspaceId, {
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
            broadcast(workspaceId, { type: "finish-step" });
            broadcast(workspaceId, { type: "finish" });
            finished = true;
          } else {
            task.status = "failed";
            task.completedAt = Date.now();
            persistTask(task);
            broadcast(workspaceId, {
              type: "error",
              errorText: `Agent error: ${event.errors.join(", ") || "unknown error"}`,
            });
            finished = true;
          }
          break;
        }

        case "error": {
          broadcast(workspaceId, {
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
      broadcast(workspaceId, {
        type: "error",
        errorText: "Agent session ended without producing a result",
      });
    }
  } catch (err) {
    task.status = "failed";
    task.completedAt = Date.now();
    persistTask(task);
    broadcast(workspaceId, {
      type: "error",
      errorText: err instanceof Error ? err.message : "Unknown error",
    });
  }

  // Auto-start a new task if there's a queued message and the task succeeded
  let autoStarted = false;
  if (task.status === "completed") {
    const queued = shiftQueuedMessage(workspaceId);
    if (queued) {
      try {
        submitTask(workspaceId, queued, task.sessionId);
        autoStarted = true;
      } catch (err) {
        log.warn({ workspaceId, err }, "failed to auto-start queued task");
      }
    }
  }

  // Update workspace status — needs_attention on success (user should review),
  // waiting on failure. Skip if a queued task already auto-started.
  if (!autoStarted) {
    const endStatus = task.status === "completed" ? "needs_attention" : "waiting";
    const updated = upsertWorkspaceStatus(workspaceId, { status: endStatus });
    emitStatusEvent({ kind: "update", status: updated });
  }
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

function toTaskInfo(task: InternalTask): TaskInfo {
  return {
    id: task.taskRecordId,
    workspaceId: task.workspaceId,
    sessionId: task.sessionId,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    prompt: task.prompt,
    maxTurns: task.maxTurns,
    mode: task.mode,
    model: task.model,
  };
}

export class TaskConflictError extends Error {
  constructor(workspaceId: string) {
    super(`Task already running for workspace ${workspaceId}`);
    this.name = "TaskConflictError";
  }
}
