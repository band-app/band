import { and, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { usageScanState as usageScanStateTable } from "../schema";

/**
 * Per-(worktree, agent) watermark store for the Reports usage scanner
 * (issue #425).
 *
 * Each tick the scanner reads each worktree's sessions for each agent
 * via `agent.listSessions(worktreeDir)`. We keep a watermark of the
 * largest `lastModified` we've already processed so subsequent ticks
 * skip unchanged sessions. The `external_key` unique constraint on
 * `usage_events` is the dedup safety net — the watermark is purely a
 * performance optimisation.
 */
export class UsageScanStateQueries {
  /** Get the current watermark for one (worktree, agent) pair, or
   *  `0` when no scan has run yet. */
  get(worktreeId: string, agentType: string): number {
    const db = getDb();
    const row = db
      .select({ lastScannedUpdatedAt: usageScanStateTable.lastScannedUpdatedAt })
      .from(usageScanStateTable)
      .where(
        and(
          eq(usageScanStateTable.worktreeId, worktreeId),
          eq(usageScanStateTable.agentType, agentType),
        ),
      )
      .get();
    return row?.lastScannedUpdatedAt ?? 0;
  }

  /** Set the watermark for one (worktree, agent) pair. */
  set(worktreeId: string, agentType: string, lastScannedUpdatedAt: number): void {
    const db = getDb();
    db.insert(usageScanStateTable)
      .values({ worktreeId, agentType, lastScannedUpdatedAt })
      .onConflictDoUpdate({
        target: [usageScanStateTable.worktreeId, usageScanStateTable.agentType],
        set: { lastScannedUpdatedAt },
      })
      .run();
  }

  /**
   * Delete all watermarks for one worktree. Called when a worktree is
   * removed so a future worktree at the same id starts from a clean
   * watermark.
   */
  deleteWorktree(worktreeId: string): number {
    const db = getDb();
    const result = db
      .delete(usageScanStateTable)
      .where(eq(usageScanStateTable.worktreeId, worktreeId))
      .run();
    return Number(result.changes ?? 0);
  }
}
