import { and, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { pendingRemovals } from "../schema";

export type PendingRemoval = typeof pendingRemovals.$inferSelect;

/** Persistence for worktrees waiting to be removed from a host that was offline when their worktree was. */
export class PendingRemovalQueries {
  /** Records a worktree to remove. Recording the same one again changes nothing. */
  add(row: Omit<PendingRemoval, "createdAt">, now = Date.now()): void {
    getDb()
      .insert(pendingRemovals)
      .values({ ...row, createdAt: now })
      .onConflictDoNothing()
      .run();
  }

  listForHost(hostId: string): PendingRemoval[] {
    return getDb().select().from(pendingRemovals).where(eq(pendingRemovals.hostId, hostId)).all();
  }

  delete(hostId: string, worktreePath: string): void {
    getDb()
      .delete(pendingRemovals)
      .where(
        and(eq(pendingRemovals.hostId, hostId), eq(pendingRemovals.worktreePath, worktreePath)),
      )
      .run();
  }
}
