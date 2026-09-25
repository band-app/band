import { readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { computeCost } from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import type { ChatEvent, TurnUsage } from "../../shared/chat-events";
import { WorkspaceNotFoundError } from "../errors";
import { generateTaskId, TaskQueries } from "../infra/db/queries/tasks";
import { mimeTypeFromFilename } from "./_utils/mime-types";
import { shiftQueuedMessage } from "./_utils/queued-message-store";
import { agentSessionService, findOption } from "./agent-session-service";
import { chatService } from "./chat-service";
import { bandHome, upsertWorkspaceStatus } from "./state";
import { emit as emitStatusEvent } from "./watcher-service";
// FRAGILE: ESM cycle leg — `workspace-service` imports `taskService` back
// from this file. The cycle is safe only because every `workspaceService`
// call below sits inside a function body — ESM live binding fills the
// reference at call time. Capturing `const ws = workspaceService;` at the
// top of this file would silently get `undefined`.
import { workspaceService } from "./workspace-service";

const log = createLogger("task-service");

/**
 * Prompt turns on a chat's coding agent (issue #648).
 *
 * A task is one prompt turn: `submitTask` records it, attaches the chat's
 * agent session through `agent-session-service` (which owns the ACP
 * connection and the event log), logs the prompt, sends `session/prompt`,
 * and logs how the turn ended. Everything the agent streams in between goes
 * straight from the ACP connection into the log. This module never
 * translates agent output; it only owns turn bookkeeping: the `tasks` table,
 * the one-turn-per-chat rule, the message queue, workspace status and the
 * shared-files scan.
 */

const taskQueries = new TaskQueries();

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
  mode?: string;
  model?: string;
  codingAgentId?: string;
}

/**
 * A file the user attached, already saved to disk. The agent gets it as an
 * ACP `resource_link` (and as an `image` block too when it is an image and
 * the agent accepts images); the chat shows it from `url`.
 */
export interface TaskAttachment {
  /** Absolute path on disk. */
  path: string;
  mediaType: string;
  /** Server URL the chat renders it from, e.g. `/api/uploads/<name>`. */
  url: string;
  filename?: string;
}

export interface SubmitTaskOptions {
  workspaceId: string;
  chatId: string;
  prompt: string;
  /**
   * Session to continue. When set and different from the chat's current
   * session, the chat switches to it first. Most callers leave it unset
   * and the chat's own session is used.
   */
  sessionId?: string;
  attachments?: TaskAttachment[];
  /** Per-turn model / mode choice, applied as a session config option. */
  mode?: string;
  model?: string;
  /** Run on a different coding agent than the chat's. */
  codingAgentId?: string;
}

interface InternalTask extends TaskInfo {
  attachments: TaskAttachment[];
  /** Stop was requested before `session/prompt` went out (the agent was
   *  still starting); the turn ends as cancelled instead of being sent. */
  cancelRequested?: boolean;
}

// Held on globalThis so every bundle of this module shares one registry.
// The key string is a frozen contract (see git history for the rename
// hazard): changing it would split the singleton.
const TASKS_KEY = Symbol.for("band.task-runner.tasks");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[TASKS_KEY]) g[TASKS_KEY] = new Map<string, InternalTask>();
/** Tasks keyed by chatId — one running task per chat pane. */
const tasks = g[TASKS_KEY] as Map<string, InternalTask>;

/**
 * A permission or elicitation request opening means the agent waits on the
 * user; its answer means the agent is working again. Registered on first
 * submit rather than at module load, because `agent-session-service` sits
 * in an import cycle with this module and isn't initialised yet then.
 */
let observingPending = false;
function observePending(): void {
  if (observingPending) return;
  observingPending = true;
  agentSessionService.observePending((workspaceId) => {
    const waiting = agentSessionService.hasPendingRequest(workspaceId);
    const running = [...tasks.values()].some(
      (t) => t.workspaceId === workspaceId && t.status === "running",
    );
    if (!running) return;
    const updated = upsertWorkspaceStatus(workspaceId, {
      status: waiting ? "needs_attention" : "working",
    });
    emitStatusEvent({ kind: "update", status: updated });
  });
}

function persistTask(task: InternalTask): void {
  const workspace = workspaceService.resolve(task.workspaceId);
  try {
    taskQueries.save({
      id: task.id,
      workspaceId: task.workspaceId,
      project: workspace?.project.name ?? "",
      branch: workspace?.worktree.branch ?? "",
      prompt: task.prompt,
      status: task.status,
      sessionId: task.sessionId,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      mode: task.mode,
      model: task.model,
      codingAgentId: task.codingAgentId,
      chatId: task.chatId,
    });
  } catch (err) {
    log.warn({ err, taskId: task.id }, "failed to persist task");
  }
}

function listFiles(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

function toTaskInfo(task: InternalTask): TaskInfo {
  const { attachments: _attachments, cancelRequested: _cancel, ...info } = task;
  return info;
}

export class TaskConflictError extends Error {
  constructor(chatId: string) {
    super(`Task already running for chat ${chatId}`);
    this.name = "TaskConflictError";
  }
}

/**
 * Re-export of the canonical `WorkspaceNotFoundError` from
 * `server/errors.ts`, so callers can keep importing it from here.
 */
export { WorkspaceNotFoundError };

// ---------------------------------------------------------------------------
// Prompt blocks
// ---------------------------------------------------------------------------

function fileUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function promptBlocks(
  task: InternalTask,
  firstTurn: boolean,
  sharedDir: string,
): Promise<acp.ContentBlock[]> {
  const caps = agentSessionService.promptCapabilities(task.chatId);
  const blocks: acp.ContentBlock[] = [{ type: "text", text: task.prompt }];
  for (const file of task.attachments) {
    const name = file.filename ?? file.path.split("/").pop() ?? file.path;
    if (caps.image && file.mediaType.startsWith("image/")) {
      try {
        const data = (await readFile(file.path)).toString("base64");
        blocks.push({ type: "image", mimeType: file.mediaType, data, uri: fileUri(file.path) });
        continue;
      } catch (err) {
        log.warn({ path: file.path, err }, "could not read image attachment; linking it instead");
      }
    }
    blocks.push({ type: "resource_link", uri: fileUri(file.path), name, mimeType: file.mediaType });
  }
  if (firstTurn) {
    blocks.push({
      type: "text",
      text: `[File sharing: to send a file to the user, write or copy it to ${sharedDir}/ and it will appear as a downloadable file card in the chat.]`,
    });
  }
  return blocks;
}

/**
 * Token usage for the finished turn. `PromptResponse.usage` is the ACP
 * field (Claude Code: the whole turn; Codex: the turn's last model call);
 * Gemini CLI reports the turn's tokens only in `_meta.quota.token_count`.
 * The cost is the agent's own cumulative figure when it sends one
 * (`usage_update.cost`, Claude Code), else the previous estimate plus this
 * turn priced from `MODEL_PRICING`.
 */
function turnUsage(
  chatId: string,
  res: acp.PromptResponse,
  previousCost: number | null,
): TurnUsage | undefined {
  const model = agentSessionService.currentModel(chatId);
  const reported = agentSessionService.reportedCost(chatId);
  let usage: TurnUsage | undefined;
  if (res.usage) {
    usage = {
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cachedReadTokens: res.usage.cachedReadTokens ?? undefined,
      cachedWriteTokens: res.usage.cachedWriteTokens ?? undefined,
      thoughtTokens: res.usage.thoughtTokens ?? undefined,
      totalTokens: res.usage.totalTokens,
    };
  } else {
    const quota = (res._meta as { quota?: { token_count?: Record<string, number> } } | null)?.quota;
    const tokens = quota?.token_count;
    if (tokens && (tokens.input_tokens !== undefined || tokens.output_tokens !== undefined)) {
      usage = { inputTokens: tokens.input_tokens ?? 0, outputTokens: tokens.output_tokens ?? 0 };
    }
  }
  if (reported !== undefined) {
    return { ...(usage ?? { inputTokens: 0, outputTokens: 0 }), model, costUsd: reported };
  }
  if (!usage) {
    return previousCost === null
      ? undefined
      : { inputTokens: 0, outputTokens: 0, model, costUsd: previousCost };
  }
  // OpenAI-style input counts include the cached part; price it once.
  const cost = computeCost(model, {
    inputTokens: Math.max(0, usage.inputTokens - (usage.cachedReadTokens ?? 0)),
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.thoughtTokens,
    cacheReadTokens: usage.cachedReadTokens,
    cacheCreationTokens: usage.cachedWriteTokens,
  });
  return { ...usage, model, costUsd: (previousCost ?? 0) + cost };
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export function submitTask(options: SubmitTaskOptions): TaskInfo {
  const { workspaceId, chatId, prompt, sessionId, mode, model, codingAgentId } = options;

  const workspace = workspaceService.resolve(workspaceId);
  if (!workspace) {
    throw new WorkspaceNotFoundError(workspaceId);
  }

  const existing = tasks.get(chatId);
  if (existing?.status === "running") {
    throw new TaskConflictError(chatId);
  }
  observePending();

  const task: InternalTask = {
    id: generateTaskId(),
    workspaceId,
    chatId,
    sessionId,
    status: "running",
    startedAt: Date.now(),
    prompt,
    mode,
    model,
    codingAgentId,
    attachments: options.attachments ?? [],
  };
  tasks.set(chatId, task);
  persistTask(task);

  runTask(task).catch((err) => {
    log.error({ chatId, err }, "task execution failed");
    finishTask(task, "failed");
  });

  return toTaskInfo(task);
}

async function runTask(task: InternalTask): Promise<void> {
  const { chatId } = task;
  chatService.updateStatus(chatId, "running");
  const working = upsertWorkspaceStatus(task.workspaceId, { status: "working" });
  emitStatusEvent({ kind: "update", status: working });

  // Prepare the chat: switch agent or session when this task asks for it.
  const chat = chatService.get(chatId);
  if (task.codingAgentId && chat && task.codingAgentId !== chat.agent) {
    agentSessionService.stop(chatId);
    chatService.update(chatId, { agent: task.codingAgentId, model: null, mode: null });
    chatService.updateActiveSession(chatId, undefined);
  }
  if (task.sessionId && chatService.get(chatId)?.activeSessionId !== task.sessionId) {
    chatService.updateActiveSession(chatId, task.sessionId);
  }

  let sessionId: string | null;
  try {
    sessionId = await agentSessionService.ensureSession(chatId, "prompt");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ chatId, err: message }, "agent failed to start");
    agentSessionService.broadcastTransient(chatId, {
      type: "notice",
      level: "error",
      text: message,
    });
    agentSessionService.broadcastTransient(chatId, {
      type: "turn-ended",
      taskId: task.id,
      error: message,
    });
    finishTask(task, "failed");
    return;
  }
  if (!sessionId) {
    finishTask(task, "failed");
    return;
  }
  task.sessionId = sessionId;
  persistTask(task);

  const current = chatService.get(chatId);
  const firstTurn = !current?.activeSessionSummary;
  if (firstTurn) {
    chatService.updateActiveSession(chatId, {
      activeSessionId: sessionId,
      summary: task.prompt,
      lastModified: Date.now(),
    });
  }

  if (task.model) await applyTurnChoice(chatId, "model", task.model);
  if (task.mode) await applyTurnChoice(chatId, "mode", task.mode);

  // Per-workspace shared directory: files the agent drops here become
  // download cards in the chat.
  const sharedDir = join(bandHome(), "shared", task.workspaceId);
  await mkdir(sharedDir, { recursive: true });
  const seenShared = listFiles(sharedDir);
  const unsubscribe = agentSessionService.subscribe(chatId, (event: ChatEvent) => {
    if (
      event.type !== "update" ||
      event.update.sessionUpdate !== "tool_call_update" ||
      event.update.status !== "completed"
    ) {
      return;
    }
    for (const filename of listFiles(sharedDir)) {
      if (seenShared.has(filename)) continue;
      seenShared.add(filename);
      agentSessionService.record(chatId, {
        type: "file",
        mediaType: mimeTypeFromFilename(filename),
        url: `/api/shared/${encodeURIComponent(task.workspaceId)}/${encodeURIComponent(filename)}`,
        filename,
      });
    }
  });

  const previousCost = agentSessionService.getSessionState(chatId).costUsd;
  agentSessionService.record(
    chatId,
    {
      type: "prompt",
      taskId: task.id,
      text: task.prompt,
      ...(task.attachments.length > 0 && {
        files: task.attachments.map((a) => ({
          mediaType: a.mediaType,
          url: a.url,
          filename: a.filename,
        })),
      }),
    },
    true,
  );
  agentSessionService.record(chatId, { type: "turn-started", taskId: task.id });

  try {
    const blocks = await promptBlocks(task, firstTurn, sharedDir);
    // Checked right before the request goes out: from here on a Stop
    // reaches the agent as `session/cancel`.
    const res = task.cancelRequested
      ? ({ stopReason: "cancelled" } as acp.PromptResponse)
      : await agentSessionService.prompt(chatId, blocks);
    agentSessionService.record(chatId, {
      type: "turn-ended",
      taskId: task.id,
      stopReason: res.stopReason,
      durationMs: Date.now() - task.startedAt,
      usage: turnUsage(chatId, res, previousCost),
    });
    finishTask(task, res.stopReason === "cancelled" ? "failed" : "completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentSessionService.record(chatId, {
      type: "turn-ended",
      taskId: task.id,
      error: message,
      durationMs: Date.now() - task.startedAt,
    });
    finishTask(task, "failed");
  } finally {
    unsubscribe();
  }
}

/** Applies a per-turn model or mode choice through the session's config. */
async function applyTurnChoice(chatId: string, category: "model" | "mode", value: string) {
  try {
    const state = agentSessionService.getSessionState(chatId);
    const option = findOption(state.configOptions, category);
    const configId = option?.id ?? (category === "model" ? "__legacy_model" : "__legacy_mode");
    await agentSessionService.setConfigOption(chatId, configId, value);
  } catch (err) {
    log.warn({ chatId, category, value, err }, "could not apply the task's setting");
  }
}

/**
 * Settles a task: records its status, then either starts the next queued
 * message or hands the workspace back to the user.
 */
function finishTask(task: InternalTask, status: "completed" | "failed"): void {
  if (task.status !== "running") return;
  task.status = status;
  task.completedAt = Date.now();
  persistTask(task);
  if (tasks.get(task.chatId) === task) tasks.delete(task.chatId);

  if (status === "completed" && drainQueue(task)) return;

  chatService.updateStatus(task.chatId, status === "completed" ? "idle" : "error");
  const endStatus = status === "completed" ? "needs_attention" : "waiting";
  const updated = upsertWorkspaceStatus(task.workspaceId, { status: endStatus });
  emitStatusEvent({ kind: "update", status: updated });
}

/** Starts the chat's next queued message, if any. */
function drainQueue(task: InternalTask): boolean {
  const queued = shiftQueuedMessage(task.chatId);
  if (!queued) return false;
  try {
    // Queued payloads already carry the saved file's absolute path (every
    // enqueue site persists the bytes first), so nothing is re-uploaded.
    const attachments = (queued.files ?? [])
      .filter((f) => f.path)
      .map((f) => ({ path: f.path, mediaType: f.mediaType, url: f.url, filename: f.filename }));
    submitTask({
      workspaceId: task.workspaceId,
      chatId: task.chatId,
      prompt: queued.text,
      attachments,
    });
    return true;
  } catch (err) {
    log.warn({ chatId: task.chatId, err }, "failed to auto-start queued task");
    return false;
  }
}

/**
 * Stops the chat's running turn. The turn ends asynchronously, when the
 * agent answers `session/cancel` (or is killed for ignoring it); the
 * `turn-ended` event and the task status follow from that.
 */
export function abortTask(chatId: string): boolean {
  const task = tasks.get(chatId);
  if (!task || task.status !== "running") return false;
  task.cancelRequested = true;
  void agentSessionService.cancel(chatId);
  log.info({ chatId }, "task abort requested");
  return true;
}

export function cancelTask(taskId: string): { cancelled: boolean; workspaceId?: string } {
  for (const [chatId, task] of tasks) {
    if (task.id === taskId && task.status === "running") {
      task.cancelRequested = true;
      void agentSessionService.cancel(chatId);
      log.info({ chatId, taskId }, "task cancel requested");
      return { cancelled: true, workspaceId: task.workspaceId };
    }
  }

  // Not running in this process: mark the persisted record as failed
  // (orphaned by a server restart).
  const record = taskQueries.markFailed(taskId);
  if (record) {
    const updated = upsertWorkspaceStatus(record.workspaceId, { status: "waiting" });
    emitStatusEvent({ kind: "update", status: updated });
    log.info({ taskId, workspaceId: record.workspaceId }, "orphaned task cancelled");
    return { cancelled: true, workspaceId: record.workspaceId };
  }
  return { cancelled: false };
}

export function getTask(chatId: string): TaskInfo | null {
  const task = tasks.get(chatId);
  return task ? toTaskInfo(task) : null;
}

/**
 * Service-tier façade over `TaskQueries` so the API tier never reaches into
 * infra directly (because routers may not import infra directly).
 */
export class TaskService {
  constructor(private readonly queries: TaskQueries = taskQueries) {}

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

  /** True while the agent in any of the workspace's chats waits on the user
   *  (a permission or elicitation request). */
  hasPendingInputForWorkspace(workspaceId: string): boolean {
    return agentSessionService.hasPendingRequest(workspaceId);
  }

  listTaskRecords(filters?: Parameters<TaskQueries["list"]>[0]) {
    return this.queries.list(filters);
  }

  loadTaskRecord(id: string) {
    return this.queries.load(id);
  }
}

/** Process-wide singleton used by routers and other services. */
export const taskService = new TaskService();
