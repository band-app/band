/** Persistence for `runner_snapshots` (plan step 3.10). */

import { asc, desc, eq, lte } from "drizzle-orm";
import { getDb } from "../connection";
import { runnerSnapshots } from "../schema";

export type RunnerSnapshotRow = typeof runnerSnapshots.$inferSelect;

export class RunnerSnapshotQueries {
  // ---- snapshots ------------------------------------------------------------

  insert(row: RunnerSnapshotRow): void {
    getDb().insert(runnerSnapshots).values(row).run();
  }

  get(id: string): RunnerSnapshotRow | undefined {
    return getDb().select().from(runnerSnapshots).where(eq(runnerSnapshots.id, id)).get();
  }

  /** The newest snapshot of a host that has not been restored, if any. */
  latestForHost(hostId: string): RunnerSnapshotRow | undefined {
    return getDb()
      .select()
      .from(runnerSnapshots)
      .where(eq(runnerSnapshots.hostId, hostId))
      .orderBy(desc(runnerSnapshots.createdAt))
      .limit(1)
      .get();
  }

  listByHost(hostId: string): RunnerSnapshotRow[] {
    return getDb()
      .select()
      .from(runnerSnapshots)
      .where(eq(runnerSnapshots.hostId, hostId))
      .orderBy(asc(runnerSnapshots.createdAt))
      .all();
  }

  /** Newest first. */
  listByRunner(runnerId: string): RunnerSnapshotRow[] {
    return getDb()
      .select()
      .from(runnerSnapshots)
      .where(eq(runnerSnapshots.runnerId, runnerId))
      .orderBy(desc(runnerSnapshots.createdAt))
      .all();
  }

  listAll(): RunnerSnapshotRow[] {
    return getDb().select().from(runnerSnapshots).orderBy(desc(runnerSnapshots.createdAt)).all();
  }

  listExpired(now: number): RunnerSnapshotRow[] {
    return getDb().select().from(runnerSnapshots).where(lte(runnerSnapshots.expiresAt, now)).all();
  }

  markRestored(id: string, at: number): void {
    getDb().update(runnerSnapshots).set({ restoredAt: at }).where(eq(runnerSnapshots.id, id)).run();
  }

  /** Clears the restored mark, for a restore that was given up on. */
  markUnrestored(id: string): void {
    getDb()
      .update(runnerSnapshots)
      .set({ restoredAt: null })
      .where(eq(runnerSnapshots.id, id))
      .run();
  }

  delete(id: string): void {
    getDb().delete(runnerSnapshots).where(eq(runnerSnapshots.id, id)).run();
  }
}
