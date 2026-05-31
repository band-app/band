import { and, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { usageScanState as usageScanStateTable } from "../schema";

/**
 * Per-(workspace, agent) watermark store for the Reports usage scanner
 * (issue #425).
 *
 * Each tick the scanner reads each workspace's sessions for each agent
 * via `agent.listSessions(workspaceDir)`. We keep a watermark of the
 * largest `lastModified` we've already processed so subsequent ticks
 * skip unchanged sessions. The `external_key` unique constraint on
 * `usage_events` is the dedup safety net — the watermark is purely a
 * performance optimisation.
 */
export class UsageScanStateQueries {
  /** Get the current watermark for one (workspace, agent) pair, or
   *  `0` when no scan has run yet. */
  get(workspaceId: string, agentType: string): number {
    const db = getDb();
    const row = db
      .select({ lastScannedUpdatedAt: usageScanStateTable.lastScannedUpdatedAt })
      .from(usageScanStateTable)
      .where(
        and(
          eq(usageScanStateTable.workspaceId, workspaceId),
          eq(usageScanStateTable.agentType, agentType),
        ),
      )
      .get();
    return row?.lastScannedUpdatedAt ?? 0;
  }

  /** Set the watermark for one (workspace, agent) pair. */
  set(workspaceId: string, agentType: string, lastScannedUpdatedAt: number): void {
    const db = getDb();
    db.insert(usageScanStateTable)
      .values({ workspaceId, agentType, lastScannedUpdatedAt })
      .onConflictDoUpdate({
        target: [usageScanStateTable.workspaceId, usageScanStateTable.agentType],
        set: { lastScannedUpdatedAt },
      })
      .run();
  }

  /**
   * Delete all watermarks for one workspace. Called when a workspace is
   * removed so a future workspace at the same id starts from a clean
   * watermark.
   */
  deleteWorkspace(workspaceId: string): number {
    const db = getDb();
    const result = db
      .delete(usageScanStateTable)
      .where(eq(usageScanStateTable.workspaceId, workspaceId))
      .run();
    return Number(result.changes ?? 0);
  }
}
