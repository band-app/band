import { createLogger } from "@band/logger";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "./db/connection";
import { loopIterations, loops } from "./db/schema";

const log = createLogger("loop-store");

export type LoopStatus = "running" | "paused" | "completed" | "failed" | "stopped";
export type IterationStatus = "running" | "completed" | "failed";

export interface LoopRecord {
  id: string;
  workspaceId: string;
  project: string;
  branch: string;
  prompt: string;
  completionPromise: string;
  maxIterations: number;
  currentIteration: number;
  status: LoopStatus;
  startedAt: number;
  completedAt?: number;
}

export interface LoopIterationRecord {
  id: string;
  loopId: string;
  iteration: number;
  status: IterationStatus;
  output?: string;
  exitCode?: number;
  promiseDetected: boolean;
  startedAt: number;
  completedAt?: number;
}

export interface LoopFilters {
  workspaceId?: string;
  project?: string;
  status?: LoopStatus;
}

export function generateLoopId(): string {
  return `loop_${Date.now()}`;
}

export function generateIterationId(): string {
  return `iter_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function saveLoop(loop: LoopRecord): void {
  const db = getDb();
  db.insert(loops)
    .values({
      id: loop.id,
      workspaceId: loop.workspaceId,
      project: loop.project,
      branch: loop.branch,
      prompt: loop.prompt,
      completionPromise: loop.completionPromise,
      maxIterations: loop.maxIterations,
      currentIteration: loop.currentIteration,
      status: loop.status,
      startedAt: loop.startedAt,
      completedAt: loop.completedAt ?? null,
    })
    .onConflictDoUpdate({
      target: loops.id,
      set: {
        workspaceId: loop.workspaceId,
        project: loop.project,
        branch: loop.branch,
        prompt: loop.prompt,
        completionPromise: loop.completionPromise,
        maxIterations: loop.maxIterations,
        currentIteration: loop.currentIteration,
        status: loop.status,
        startedAt: loop.startedAt,
        completedAt: loop.completedAt ?? null,
      },
    })
    .run();
}

export function loadLoop(id: string): LoopRecord | null {
  const db = getDb();
  const row = db.select().from(loops).where(eq(loops.id, id)).get();
  if (!row) return null;
  return rowToLoopRecord(row);
}

export function listLoops(filters?: LoopFilters): LoopRecord[] {
  const db = getDb();
  const conditions = [];

  if (filters?.workspaceId) {
    conditions.push(eq(loops.workspaceId, filters.workspaceId));
  }
  if (filters?.project) {
    conditions.push(eq(loops.project, filters.project));
  }
  if (filters?.status) {
    conditions.push(eq(loops.status, filters.status));
  }

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(loops)
          .where(and(...conditions))
          .orderBy(desc(loops.startedAt))
      : db.select().from(loops).orderBy(desc(loops.startedAt));

  return query.all().map(rowToLoopRecord);
}

export function saveIteration(iter: LoopIterationRecord): void {
  const db = getDb();
  db.insert(loopIterations)
    .values({
      id: iter.id,
      loopId: iter.loopId,
      iteration: iter.iteration,
      status: iter.status,
      output: iter.output ?? null,
      exitCode: iter.exitCode ?? null,
      promiseDetected: iter.promiseDetected,
      startedAt: iter.startedAt,
      completedAt: iter.completedAt ?? null,
    })
    .onConflictDoUpdate({
      target: loopIterations.id,
      set: {
        loopId: iter.loopId,
        iteration: iter.iteration,
        status: iter.status,
        output: iter.output ?? null,
        exitCode: iter.exitCode ?? null,
        promiseDetected: iter.promiseDetected,
        startedAt: iter.startedAt,
        completedAt: iter.completedAt ?? null,
      },
    })
    .run();
}

export function listIterations(loopId: string): LoopIterationRecord[] {
  const db = getDb();
  return db
    .select()
    .from(loopIterations)
    .where(eq(loopIterations.loopId, loopId))
    .orderBy(asc(loopIterations.iteration))
    .all()
    .map(rowToIterationRecord);
}

/**
 * Mark all persisted "running" loops as "failed".
 * Called on server start before listening — no loop can be running if the server just started.
 */
export function cleanupStaleLoops(): number {
  const db = getDb();
  const now = Date.now();
  const result = db
    .update(loops)
    .set({ status: "failed", completedAt: now })
    .where(eq(loops.status, "running"))
    .run();

  const count = result.changes;
  if (count > 0) {
    log.info({ count }, "cleaned up stale loops on startup");
  }

  // Also clean up any stale running iterations
  db.update(loopIterations)
    .set({ status: "failed", completedAt: now })
    .where(eq(loopIterations.status, "running"))
    .run();

  return count;
}

function rowToLoopRecord(row: typeof loops.$inferSelect): LoopRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    project: row.project,
    branch: row.branch,
    prompt: row.prompt,
    completionPromise: row.completionPromise,
    maxIterations: row.maxIterations,
    currentIteration: row.currentIteration,
    status: row.status as LoopStatus,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

function rowToIterationRecord(row: typeof loopIterations.$inferSelect): LoopIterationRecord {
  return {
    id: row.id,
    loopId: row.loopId,
    iteration: row.iteration,
    status: row.status as IterationStatus,
    output: row.output ?? undefined,
    exitCode: row.exitCode ?? undefined,
    promiseDetected: row.promiseDetected,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
  };
}
