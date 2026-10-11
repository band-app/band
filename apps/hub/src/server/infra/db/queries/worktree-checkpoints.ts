/** Persistence for `worktree_checkpoints`: what the hub keeps of worktrees on static workers. */

import { desc, eq, inArray, max } from "drizzle-orm";
import { getDb } from "../connection";
import { worktreeCheckpoints } from "../schema";

export type CheckpointRow = typeof worktreeCheckpoints.$inferSelect;

export class CheckpointQueries {
  insert(row: CheckpointRow): void {
    getDb().insert(worktreeCheckpoints).values(row).run();
  }

  get(id: string): CheckpointRow | undefined {
    return getDb().select().from(worktreeCheckpoints).where(eq(worktreeCheckpoints.id, id)).get();
  }

  /** The worktree's checkpoints, newest first. */
  list(worktreeId: string): CheckpointRow[] {
    return getDb()
      .select()
      .from(worktreeCheckpoints)
      .where(eq(worktreeCheckpoints.worktreeId, worktreeId))
      .orderBy(desc(worktreeCheckpoints.createdAt), desc(worktreeCheckpoints.id))
      .all();
  }

  latest(worktreeId: string): CheckpointRow | undefined {
    return this.list(worktreeId)[0];
  }

  /** The time of the newest checkpoint of every worktree that has one. */
  latestTimes(): Map<string, number> {
    const rows = getDb()
      .select({
        worktreeId: worktreeCheckpoints.worktreeId,
        at: max(worktreeCheckpoints.createdAt),
      })
      .from(worktreeCheckpoints)
      .groupBy(worktreeCheckpoints.worktreeId)
      .all();
    return new Map(rows.flatMap((r) => (r.at == null ? [] : [[r.worktreeId, r.at] as const])));
  }

  delete(ids: string[]): void {
    if (ids.length === 0) return;
    getDb().delete(worktreeCheckpoints).where(inArray(worktreeCheckpoints.id, ids)).run();
  }

  deleteForWorktree(worktreeId: string): void {
    getDb().delete(worktreeCheckpoints).where(eq(worktreeCheckpoints.worktreeId, worktreeId)).run();
  }

  /** The ids of every worktree of `repo` that has a checkpoint. */
  worktreeIdsForRepo(repo: string): string[] {
    return getDb()
      .selectDistinct({ worktreeId: worktreeCheckpoints.worktreeId })
      .from(worktreeCheckpoints)
      .where(eq(worktreeCheckpoints.repo, repo))
      .all()
      .map((r) => r.worktreeId);
  }
}
