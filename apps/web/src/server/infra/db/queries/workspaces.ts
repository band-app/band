import { eq, sql } from "drizzle-orm";
import { toWorkspaceId } from "@/dashboard";
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
   * worktree path) by scanning the `worktrees` table.
   *
   * The match expression mirrors `toWorkspaceId(project, name)`:
   *   `${project}-${name.replaceAll("/", "-")}`
   * where `name` is the immutable workspace identity (see the `worktrees`
   * schema), NOT the live `branch`. SQLite's `REPLACE(str, "/", "-")` is
   * also a replace-all, so this is bit-identical to the JS computation.
   * Pushing the match down into SQL lets us read at most one row instead of
   * fanning out the projects + worktrees tree just to find a single
   * workspace (the previous `loadState()`-based implementation walked every
   * project's worktree list to find the match in JS).
   *
   * The returned `branch` is the live git branch, still useful to callers
   * that want the current checkout — identity is by `name`, git ops by
   * `branch`.
   *
   * Called from two places today: the workspace-status upsert path in
   * `lib/state.ts::upsertWorkspaceStatus` (via the private
   * `resolveWorkspaceIdentity` helper, which delegates here so the SQL
   * lives in one place) and any future service caller that needs to map
   * an opaque `workspaceId` back to its on-disk worktree without
   * loading the full project tree.
   *
   * TODO: `toWorkspaceId`'s encoding is not injective — project `foo-bar` +
   * name `main` and project `foo` + name `bar/main` both serialize to
   * `foo-bar-main`. `.get()` returns whichever row SQLite finds first, and
   * the sanity check below cannot disambiguate (both candidates satisfy
   * it). Fixing this requires changing the workspace-id encoding, which is
   * a cross-cutting change tracked separately from this refactor.
   */
  findIdentity(workspaceId: string): WorkspaceIdentity | null {
    const db = getDb();
    const row = db
      .select({
        project: worktreesTable.projectName,
        name: worktreesTable.name,
        branch: worktreesTable.branch,
        worktreePath: worktreesTable.path,
      })
      .from(worktreesTable)
      .where(
        sql`${worktreesTable.projectName} || '-' || REPLACE(${worktreesTable.name}, '/', '-') = ${workspaceId}`,
      )
      .get();
    // Use the `toWorkspaceId` helper as a runtime sanity check in case the
    // helper's encoding ever evolves to disagree with the SQL above.
    if (row && toWorkspaceId(row.project, row.name) === workspaceId) {
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
