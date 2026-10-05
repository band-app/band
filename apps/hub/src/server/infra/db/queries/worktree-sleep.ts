/** Persistence for `worktree_sleep`: worktrees whose ephemeral worker exited (plan step 3.5). */

import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { worktreeSleep } from "../schema";

export type WorktreeSleepRow = typeof worktreeSleep.$inferSelect;

export class WorktreeSleepQueries {
  insert(row: WorktreeSleepRow): void {
    getDb()
      .insert(worktreeSleep)
      .values(row)
      .onConflictDoUpdate({ target: worktreeSleep.worktreeId, set: row })
      .run();
  }

  get(worktreeId: string): WorktreeSleepRow | undefined {
    return getDb()
      .select()
      .from(worktreeSleep)
      .where(eq(worktreeSleep.worktreeId, worktreeId))
      .get();
  }

  listAll(): WorktreeSleepRow[] {
    return getDb().select().from(worktreeSleep).all();
  }

  listByHost(hostId: string): WorktreeSleepRow[] {
    return getDb().select().from(worktreeSleep).where(eq(worktreeSleep.hostId, hostId)).all();
  }

  delete(worktreeId: string): void {
    getDb().delete(worktreeSleep).where(eq(worktreeSleep.worktreeId, worktreeId)).run();
  }

  deleteByHost(hostId: string): void {
    getDb().delete(worktreeSleep).where(eq(worktreeSleep.hostId, hostId)).run();
  }

  setWaking(hostId: string, at: number | null): void {
    getDb()
      .update(worktreeSleep)
      .set({ wakingSince: at })
      .where(eq(worktreeSleep.hostId, hostId))
      .run();
  }
}
