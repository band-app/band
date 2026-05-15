import { createLogger } from "@band-app/logger";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "./db/connection";
import { tasks } from "./db/schema";

const log = createLogger("task-store");

export type TaskStatus = "running" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  workspaceId: string;
  project: string;
  branch: string;
  prompt: string;
  status: TaskStatus;
  sessionId?: string;
  startedAt: number;
  completedAt?: number;
  maxTurns?: number;
  mode?: string;
  model?: string;
  codingAgentId?: string;
  chatId?: string;
}

export interface TaskFilters {
  project?: string;
  workspaceId?: string;
  status?: TaskStatus;
  sessionId?: string;
  chatId?: string;
}

export function generateTaskId(): string {
  return `tsk_${Date.now()}`;
}

export function saveTask(task: TaskRecord): void {
  const db = getDb();
  db.insert(tasks)
    .values({
      id: task.id,
      workspaceId: task.workspaceId,
      project: task.project,
      branch: task.branch,
      prompt: task.prompt,
      status: task.status,
      sessionId: task.sessionId ?? null,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? null,
      maxTurns: task.maxTurns ?? null,
      mode: task.mode ?? null,
      model: task.model ?? null,
      codingAgentId: task.codingAgentId ?? null,
      chatId: task.chatId ?? null,
    })
    .onConflictDoUpdate({
      target: tasks.id,
      set: {
        workspaceId: task.workspaceId,
        project: task.project,
        branch: task.branch,
        prompt: task.prompt,
        status: task.status,
        sessionId: task.sessionId ?? null,
        startedAt: task.startedAt,
        completedAt: task.completedAt ?? null,
        maxTurns: task.maxTurns ?? null,
        mode: task.mode ?? null,
        model: task.model ?? null,
        codingAgentId: task.codingAgentId ?? null,
        chatId: task.chatId ?? null,
      },
    })
    .run();
}

export function loadTask(id: string): TaskRecord | null {
  const db = getDb();
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) return null;
  return rowToRecord(row);
}

export function listTasks(filters?: TaskFilters): TaskRecord[] {
  const db = getDb();
  const conditions = [];

  if (filters?.project) {
    conditions.push(eq(tasks.project, filters.project));
  }
  if (filters?.workspaceId) {
    conditions.push(eq(tasks.workspaceId, filters.workspaceId));
  }
  if (filters?.status) {
    conditions.push(eq(tasks.status, filters.status));
  }
  if (filters?.sessionId) {
    conditions.push(eq(tasks.sessionId, filters.sessionId));
  }
  if (filters?.chatId) {
    conditions.push(eq(tasks.chatId, filters.chatId));
  }

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(tasks)
          .where(and(...conditions))
          .orderBy(desc(tasks.startedAt))
      : db.select().from(tasks).orderBy(desc(tasks.startedAt));

  return query.all().map(rowToRecord);
}

/**
 * Mark all persisted "running" tasks as "failed".
 * Called on server start before listening — no agent can be running if the server just started.
 */
export function cleanupStaleTasks(): number {
  const db = getDb();
  const now = Date.now();
  const result = db
    .update(tasks)
    .set({ status: "failed", completedAt: now })
    .where(eq(tasks.status, "running"))
    .run();

  const count = result.changes;
  if (count > 0) {
    log.info({ count }, "cleaned up stale tasks on startup");
  }
  return count;
}

/**
 * Delete all tasks belonging to a workspace.
 *
 * Called when a workspace is removed (`projects.remove` in `trpc/router.ts`).
 * Workspaces are not first-class DB rows (they live in `state.json`), so we
 * can't lean on `ON DELETE CASCADE` — the caller is responsible for invoking
 * this helper next to the other workspace-scoped cleanups.
 *
 * Returns the number of rows deleted.
 */
export function deleteWorkspaceTasks(workspaceId: string): number {
  const db = getDb();
  const result = db.delete(tasks).where(eq(tasks.workspaceId, workspaceId)).run();
  return result.changes;
}

/**
 * Delete tasks whose effective age timestamp is older than `cutoffMs`.
 *
 * "Age" is measured against `completedAt` when present, and falls back to
 * `startedAt` for tasks that never completed (e.g. orphans from a previous
 * crash that `cleanupStaleTasks` didn't see because the row predates the
 * current schema, or rows that were inserted but never updated). This way
 * a stuck `running` row from a month ago is still pruned instead of living
 * forever.
 *
 * Returns the number of rows deleted.
 */
export function deleteTasksOlderThan(cutoffMs: number): number {
  const db = getDb();
  // NOTE: `startedAt` is `NOT NULL` in the schema, so the first branch covers
  // every NULL-`completedAt` row that's older than the cutoff. A row with both
  // columns NULL would match neither branch and live forever, but the insert
  // path always sets `startedAt`, so that combination is unreachable today.
  const result = db
    .delete(tasks)
    .where(
      or(
        and(isNull(tasks.completedAt), lt(tasks.startedAt, cutoffMs)),
        // NULL-`completedAt` rows are already handled by the first branch.
        // In SQLite, `NULL < cutoffMs` evaluates to NULL (falsy in a WHERE
        // predicate), so this branch only matches rows where `completedAt`
        // is non-null and older than the cutoff.
        lt(tasks.completedAt, cutoffMs),
      ),
    )
    .run();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Periodic prune (issue #416)
// ---------------------------------------------------------------------------

/** Retention window for completed/abandoned task rows. */
export const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How often the background sweep re-runs after the first pass on boot. */
export const TASK_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const PRUNE_SCHEDULER_KEY = Symbol.for("band.task-prune-scheduler");
const pruneG = globalThis as unknown as Record<symbol, unknown>;

interface PruneSchedulerState {
  timer: NodeJS.Timeout | null;
}

if (!pruneG[PRUNE_SCHEDULER_KEY]) {
  pruneG[PRUNE_SCHEDULER_KEY] = { timer: null } satisfies PruneSchedulerState;
}

const pruneState = pruneG[PRUNE_SCHEDULER_KEY] as PruneSchedulerState;

/**
 * Run a single prune pass with the default 30-day retention window.
 * Exposed as its own export so tests (and the boot path) can trigger a
 * deterministic sweep without standing up the interval timer.
 */
export function pruneOldTasks(retentionMs: number = TASK_RETENTION_MS): number {
  const cutoff = Date.now() - retentionMs;
  const count = deleteTasksOlderThan(cutoff);
  if (count > 0) {
    log.info({ count, retentionMs }, "pruned tasks older than retention window");
  }
  return count;
}

/**
 * Start the background prune sweep.
 *
 * Runs one pass immediately, then re-runs every `intervalMs` (default 24h).
 * Idempotent: a second call is a no-op while the previous timer is still
 * active. The timer is `unref()`'d so it doesn't keep the event loop alive
 * during shutdown.
 */
export function startTaskPruneScheduler(
  options: { retentionMs?: number; intervalMs?: number } = {},
): void {
  if (pruneState.timer) return;

  const retentionMs = options.retentionMs ?? TASK_RETENTION_MS;
  const intervalMs = options.intervalMs ?? TASK_PRUNE_INTERVAL_MS;

  // Log-and-continue: a DB lock or corruption at boot time must not crash
  // `main()` before the server binds its port. The interval handler below
  // applies the same policy.
  try {
    pruneOldTasks(retentionMs);
  } catch (err) {
    log.error({ err }, "initial task prune on boot failed");
  }

  const timer = setInterval(() => {
    try {
      pruneOldTasks(retentionMs);
    } catch (err) {
      log.error({ err }, "scheduled task prune failed");
    }
  }, intervalMs);
  timer.unref();
  pruneState.timer = timer;
}

/** Stop the background prune sweep. Used on graceful shutdown and in tests. */
export function stopTaskPruneScheduler(): void {
  if (pruneState.timer) {
    clearInterval(pruneState.timer);
    pruneState.timer = null;
  }
}

/**
 * Mark a persisted task as "failed" by ID.
 * Returns the updated record, or null if not found or already not running.
 */
export function markTaskFailed(id: string): TaskRecord | null {
  const task = loadTask(id);
  if (!task || task.status !== "running") return null;

  const now = Date.now();
  const db = getDb();
  db.update(tasks).set({ status: "failed", completedAt: now }).where(eq(tasks.id, id)).run();

  task.status = "failed";
  task.completedAt = now;
  return task;
}

function rowToRecord(row: typeof tasks.$inferSelect): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    project: row.project,
    branch: row.branch,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    sessionId: row.sessionId ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    maxTurns: row.maxTurns ?? undefined,
    mode: row.mode ?? undefined,
    model: row.model ?? undefined,
    codingAgentId: row.codingAgentId ?? undefined,
    chatId: row.chatId ?? undefined,
  };
}
