/**
 * Persistence for worktree groups (`worktree_groups`). A worktree is in at most one group, named
 * by `worktrees.group_id`, which `RepoQueries.setGroup` writes. Deleting a group sets that column
 * to null for its worktrees and never touches the rows themselves.
 */

import { and, asc, eq, isNotNull, notInArray } from "drizzle-orm";
import { getDb } from "../connection";
import { worktreeGroups, worktrees } from "../schema";

export interface WorktreeGroupRow {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: number;
}

export class WorktreeGroupQueries {
  list(): WorktreeGroupRow[] {
    return getDb().select().from(worktreeGroups).orderBy(asc(worktreeGroups.sortOrder)).all();
  }

  find(id: string): WorktreeGroupRow | undefined {
    return getDb().select().from(worktreeGroups).where(eq(worktreeGroups.id, id)).get();
  }

  /** Inserts a group; one that already has the id is left as it is. */
  insert(row: WorktreeGroupRow): void {
    getDb().insert(worktreeGroups).values(row).onConflictDoNothing().run();
  }

  update(id: string, patch: { name?: string; color?: string }): void {
    if (patch.name === undefined && patch.color === undefined) return;
    getDb().update(worktreeGroups).set(patch).where(eq(worktreeGroups.id, id)).run();
  }

  /** Deletes the group and puts its worktrees in no group, in one transaction. */
  remove(id: string): void {
    getDb().transaction((tx) => {
      tx.update(worktrees).set({ groupId: null }).where(eq(worktrees.groupId, id)).run();
      tx.delete(worktreeGroups).where(eq(worktreeGroups.id, id)).run();
    });
  }

  /** Stores the order: each listed id gets its index, others keep their relative order after. */
  reorder(ids: string[]): void {
    getDb().transaction((tx) => {
      ids.forEach((id, i) => {
        tx.update(worktreeGroups).set({ sortOrder: i }).where(eq(worktreeGroups.id, id)).run();
      });
      const rest = tx
        .select({ id: worktreeGroups.id })
        .from(worktreeGroups)
        .where(notInArray(worktreeGroups.id, ids))
        .orderBy(asc(worktreeGroups.sortOrder))
        .all();
      rest.forEach((r, i) => {
        tx.update(worktreeGroups)
          .set({ sortOrder: ids.length + i })
          .where(eq(worktreeGroups.id, r.id))
          .run();
      });
    });
  }

  /** Sets `group_id` to null where it names no group. Run at boot, after the labels are converted. */
  clearDangling(): number {
    const ids = this.list().map((g) => g.id);
    const res = getDb()
      .update(worktrees)
      .set({ groupId: null })
      .where(
        ids.length
          ? and(isNotNull(worktrees.groupId), notInArray(worktrees.groupId, ids))
          : isNotNull(worktrees.groupId),
      )
      .run();
    return Number(res.changes);
  }
}
