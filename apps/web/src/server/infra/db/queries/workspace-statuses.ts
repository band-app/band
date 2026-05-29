/**
 * Read-side data access for the `workspace_statuses` table.
 *
 * Infra tier — owns the SQL for reading workspace-status rows. Created
 * to resolve the `TODO(#313 follow-up)` parked in `ProjectService.list`,
 * which previously imported `loadCurrentStatuses` from `services/state`
 * (a cross-tier dependency the architecture doc forbids).
 *
 * The write-side helpers (`upsertWorkspaceStatus`, `resetAgentStatuses`,
 * `deleteWorkspaceStatus`) still live in `services/state.ts` because
 * they encode business decisions (identity self-heal, change-detection
 * to skip no-op writes, status reset on boot). Promoting them into a
 * full query class is in scope for a separate refactor.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { workspaceStatuses as workspaceStatusesTable } from "../schema";
import type { WorkspaceStatusSnapshot } from "../../events/status-event-bus";

function rowToSnapshot(row: typeof workspaceStatusesTable.$inferSelect): WorkspaceStatusSnapshot {
  return {
    workspaceId: row.workspaceId,
    project: row.project,
    branch: row.branch,
    worktreePath: row.worktreePath,
    agent: row.agentName
      ? {
          name: row.agentName,
          status: row.agentStatus ?? "unknown",
          lastActivity: row.agentLastActivity ?? "",
          summary: row.agentSummary ?? undefined,
          codingAgentId: row.codingAgentId ?? undefined,
        }
      : undefined,
  };
}

export class WorkspaceStatusQueries {
  /**
   * Read every workspace status row and translate to the
   * `WorkspaceStatusSnapshot` shape consumed by the dashboard.
   *
   * Used by the project list endpoint (which joins per-workspace agent
   * info into the projects/worktrees tree) and by the watcher's
   * on-subscribe snapshot replay.
   */
  loadCurrent(): WorkspaceStatusSnapshot[] {
    const db = getDb();
    const rows = db.select().from(workspaceStatusesTable).all();
    return rows.map(rowToSnapshot);
  }

  /**
   * Look up a single workspace's status row, or `null` when no row
   * exists yet (the workspace was created but no agent has touched it).
   */
  getByWorkspaceId(workspaceId: string): WorkspaceStatusSnapshot | null {
    const db = getDb();
    const row = db
      .select()
      .from(workspaceStatusesTable)
      .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
      .get();
    if (!row) return null;
    return rowToSnapshot(row);
  }
}
