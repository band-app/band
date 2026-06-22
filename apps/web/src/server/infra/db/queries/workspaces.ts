import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { branchStatuses as branchStatusesTable, worktrees as worktreesTable } from "../schema";

/**
 * Identity of a workspace as stored on disk — what project owns it, the
 * branch checked out in the worktree, and the worktree path. This is the
 * shape `WorkspaceQueries.findIdentity` returns to higher tiers that need
 * to locate the on-disk worktree given an opaque `workspaceId`.
 */
export interface WorkspaceIdentity {
  project: string;
  branch: string;
  worktreePath: string;
}

/**
 * Workspace-scoped data access layer (Phase 3 of the 3-tier refactor —
 * issue #314).
 *
 * Infra tier — owns the persistence concerns for the workspace domain:
 *
 *   - The `worktrees` table (rows synthesizing the one-worktree-per-branch
 *     model on top of git worktrees).
 *   - Per-workspace branch status (`branch_statuses` — git/CI columns
 *     driven by `branch-status-poller`).
 *
 * `workspace_statuses` rows (agent name/status/summary) are still co-managed
 * by the agent lifecycle in `lib/state.ts`; only the workspace-delete-side
 * cleanup lives here so the service layer can drive a workspace removal
 * through a single object. Promoting the rest of `workspace_statuses` into
 * this class is in scope for a follow-up alongside the agent / task tier
 * migration.
 *
 * NOTE: today's worktrees-table writes still go through the whole-tree
 * `saveState` rewrite in `lib/state.ts` (it deletes + reinserts the
 * `projects` + `worktrees` tables together inside one transaction). That
 * persistence model belongs to the projects domain and is owned by Phase 2
 * (`ProjectQueries`, issue #313); until that ships, the workspace service
 * continues to call `loadState`/`saveState` for the table mutations and
 * this class only exposes the read-side and the status-table cleanup paths
 * the service needs.
 */
export class WorkspaceQueries {
  /**
   * Resolve a workspace ID back to its on-disk identity (project, branch,
   * worktree path) with a single indexed lookup on the stored
   * `worktrees.workspace_id` column.
   *
   * `workspace_id` is the worktree's frozen identity (minted once at
   * creation, never re-derived from the mutable branch), so this match is
   * exact and unambiguous — it replaces the old `project || '-' ||
   * REPLACE(branch, '/', '-')` expression, which collided whenever a
   * project name contained a `-` (project `foo-bar` + branch `main` and
   * project `foo` + branch `bar/main` both serialized to `foo-bar-main`).
   */
  findIdentity(workspaceId: string): WorkspaceIdentity | null {
    const db = getDb();
    const row = db
      .select({
        project: worktreesTable.projectName,
        branch: worktreesTable.branch,
        worktreePath: worktreesTable.path,
      })
      .from(worktreesTable)
      .where(eq(worktreesTable.workspaceId, workspaceId))
      .get();
    if (row) {
      return { project: row.project, branch: row.branch, worktreePath: row.worktreePath };
    }
    return null;
  }

  /**
   * Delete the `branch_statuses` row for the given workspace.
   *
   * Called from the workspace remove path to clear the per-workspace git /
   * CI snapshot the dashboard reads. No-op if the row doesn't exist (the
   * poller may not have ticked yet for a freshly-created workspace).
   */
  deleteBranchStatus(workspaceId: string): void {
    const db = getDb();
    db.delete(branchStatusesTable).where(eq(branchStatusesTable.workspaceId, workspaceId)).run();
  }
}
