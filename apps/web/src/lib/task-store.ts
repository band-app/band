import { createLogger } from "@band-app/logger";
import { and, desc, eq } from "drizzle-orm";
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
}

export interface TaskFilters {
  project?: string;
  workspaceId?: string;
  status?: TaskStatus;
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
  };
}
