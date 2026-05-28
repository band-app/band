import { createLogger } from "@band-app/logger";
import { and, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../connection";
import { tasks as tasksTable } from "../schema";

const log = createLogger("task-queries");

/**
 * Persisted-task status. Mirrors the `tasks.status` enum in `schema.ts`.
 *
 * Kept distinct from the in-memory `TaskInfo.status` (declared in the
 * service tier) because the service tier may add transient states (e.g.
 * `pending` for queued tasks) without touching the persisted column.
 */
export type TaskStatus = "running" | "completed" | "failed";

/**
 * A row from the `tasks` table, exposed with optional fields collapsed to
 * `T | undefined` so the service tier can pass these around without
 * sprinkling `?? undefined` everywhere. Conversion happens inside
 * `TaskQueries.rowToRecord`.
 */
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

/**
 * Mint a process-unique task id.
 *
 * The random suffix is required: `Date.now()` has millisecond resolution
 * and two tasks started in the same millisecond (e.g. during a burst of
 * cron-triggered submissions) would otherwise collide. Because `save()`
 * uses `onConflictDoUpdate` on `tasks.id`, a collision would silently
 * overwrite an in-flight task row with a different task's data rather
 * than fail loudly, so we guarantee uniqueness here.
 */
export function generateTaskId(): string {
  return `tsk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Retention window for completed/abandoned task rows. */
export const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How often the background sweep re-runs after the first pass on boot. */
export const TASK_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Database-backed data access for the `tasks` table (Phase 6 of the 3-tier
 * refactor — issue #317).
 *
 * Infra tier — knows nothing about services or routers. The class is a thin
 * wrapper around Drizzle calls; the calling service layer (`TaskService`)
 * handles the in-memory streaming + lifecycle that the legacy
 * `lib/task-runner.ts` mixed in with persistence.
 *
 * Methods are intentionally aligned with the legacy `lib/task-store.ts`
 * helpers so the service tier can be a near-mechanical port of the existing
 * router code.
 */
export class TaskQueries {
  /** Upsert a task row by id. */
  save(task: TaskRecord): void {
    const db = getDb();
    db.insert(tasksTable)
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
        target: tasksTable.id,
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

  /** Load a single task by id. Returns `null` if absent. */
  load(id: string): TaskRecord | null {
    const db = getDb();
    const row = db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
    if (!row) return null;
    return TaskQueries.rowToRecord(row);
  }

  /**
   * List tasks matching the supplied filters, newest first.
   *
   * Passing `undefined` (or omitting all filter fields) returns every row in
   * `started_at DESC` order. Each filter is an exact-match predicate on the
   * corresponding column.
   */
  list(filters?: TaskFilters): TaskRecord[] {
    const db = getDb();
    const conditions = [];

    if (filters?.project) {
      conditions.push(eq(tasksTable.project, filters.project));
    }
    if (filters?.workspaceId) {
      conditions.push(eq(tasksTable.workspaceId, filters.workspaceId));
    }
    if (filters?.status) {
      conditions.push(eq(tasksTable.status, filters.status));
    }
    if (filters?.sessionId) {
      conditions.push(eq(tasksTable.sessionId, filters.sessionId));
    }
    if (filters?.chatId) {
      conditions.push(eq(tasksTable.chatId, filters.chatId));
    }

    const query =
      conditions.length > 0
        ? db
            .select()
            .from(tasksTable)
            .where(and(...conditions))
            .orderBy(desc(tasksTable.startedAt))
        : db.select().from(tasksTable).orderBy(desc(tasksTable.startedAt));

    return query.all().map(TaskQueries.rowToRecord);
  }

  /**
   * Mark all persisted "running" tasks as "failed".
   * Called on server start before listening — no agent can be running if
   * the server just started.
   *
   * Returns the number of rows that flipped.
   */
  cleanupStale(): number {
    const db = getDb();
    const now = Date.now();
    const result = db
      .update(tasksTable)
      .set({ status: "failed", completedAt: now })
      .where(eq(tasksTable.status, "running"))
      .run();

    const count = Number(result.changes ?? 0);
    if (count > 0) {
      log.info({ count }, "cleaned up stale tasks on startup");
    }
    return count;
  }

  /**
   * Delete all tasks belonging to a workspace.
   *
   * Called when a workspace is removed. Workspaces are not first-class DB
   * rows (they live in `state.json`), so we can't lean on `ON DELETE
   * CASCADE` — the caller is responsible for invoking this helper next to
   * the other workspace-scoped cleanups.
   *
   * Returns the number of rows deleted.
   */
  deleteWorkspaceTasks(workspaceId: string): number {
    const db = getDb();
    const result = db.delete(tasksTable).where(eq(tasksTable.workspaceId, workspaceId)).run();
    return Number(result.changes ?? 0);
  }

  /**
   * Delete tasks whose effective age timestamp is older than `cutoffMs`.
   *
   * "Age" is measured against `completedAt` when present, and falls back to
   * `startedAt` for tasks that never completed (e.g. orphans from a previous
   * crash that `cleanupStale` didn't see because the row predates the
   * current schema, or rows that were inserted but never updated). This way
   * a stuck `running` row from a month ago is still pruned instead of living
   * forever.
   *
   * The query intentionally has no `status` filter: a row that's still
   * marked `running` 30 days after it was started is by definition stale
   * (every server boot calls `cleanupStale` to flip dangling `running`
   * rows to `failed`, so an in-flight task can survive a server restart
   * but not 30 days of restarts).
   *
   * Returns the number of rows deleted.
   */
  deleteOlderThan(cutoffMs: number): number {
    const db = getDb();
    // NOTE: `startedAt` is `NOT NULL` in the schema, so the first branch
    // covers every NULL-`completedAt` row that's older than the cutoff. A
    // row with both columns NULL would match neither branch and live
    // forever, but the insert path always sets `startedAt`, so that
    // combination is unreachable today.
    const result = db
      .delete(tasksTable)
      .where(
        or(
          and(isNull(tasksTable.completedAt), lt(tasksTable.startedAt, cutoffMs)),
          // The explicit `isNotNull` guard is technically redundant — SQLite
          // treats `NULL < cutoffMs` as NULL (falsy) in a WHERE predicate,
          // so null-`completedAt` rows would be skipped here regardless. We
          // keep it so the intent is obvious without leaning on SQLite NULL
          // semantics, and so the query stays correct under a future
          // Drizzle or backend swap.
          and(isNotNull(tasksTable.completedAt), lt(tasksTable.completedAt, cutoffMs)),
        ),
      )
      .run();
    return Number(result.changes ?? 0);
  }

  /**
   * Mark a persisted task as "failed" by id.
   *
   * Returns the updated record, or `null` if not found or not currently
   * running. The "not currently running" branch is the orphan-task path:
   * the caller wants to flip a stuck row without trampling on the existing
   * status of completed/failed tasks.
   */
  markFailed(id: string): TaskRecord | null {
    const task = this.load(id);
    if (!task || task.status !== "running") return null;

    const now = Date.now();
    const db = getDb();
    db.update(tasksTable)
      .set({ status: "failed", completedAt: now })
      .where(eq(tasksTable.id, id))
      .run();

    task.status = "failed";
    task.completedAt = now;
    return task;
  }

  private static rowToRecord(row: typeof tasksTable.$inferSelect): TaskRecord {
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
}

// ---------------------------------------------------------------------------
// Periodic prune scheduler (issue #416)
//
// Kept in the infra file because it's a thin DB sweep with no business
// logic — the timer just calls `TaskQueries.deleteOlderThan` on an
// interval. The shared `globalThis` symbol survives HMR / module
// re-evaluation, same as the agent pool and cronjob scheduler.
// ---------------------------------------------------------------------------

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
 *
 * Exposed as its own export so tests (and the boot path) can trigger a
 * deterministic sweep without standing up the interval timer.
 */
export function pruneOldTasks(retentionMs: number = TASK_RETENTION_MS): number {
  const cutoff = Date.now() - retentionMs;
  const count = new TaskQueries().deleteOlderThan(cutoff);
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
