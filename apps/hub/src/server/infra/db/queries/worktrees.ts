import { toWorktreeId } from "@band-app/shared/worktree-id";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { branchStatuses as branchStatusesTable, worktrees as worktreesTable } from "../schema";

/**
 * Identity of a worktree as stored on disk — what repo owns it, the
 * branch checked out in the worktree, and the worktree path. This is the
 * shape `WorktreeQueries.findIdentity` returns to higher tiers that need
 * to locate the on-disk worktree given an opaque `worktreeId`.
 */
export interface WorktreeIdentity {
  repo: string;
  branch: string;
  worktreePath: string;
}

/**
 * SQL form of `toWorktreeId(repo, name, hostId)`: `<repo>-<name>` on the local host and
 * `<repo>-<name>@<hostId>` elsewhere.
 */
export function WORKTREE_ID_MATCH(worktreeId: string) {
  return sql`${worktreesTable.repoName} || '-' || REPLACE(${worktreesTable.name}, '/', '-') || CASE WHEN ${worktreesTable.hostId} = 'local' THEN '' ELSE '@' || ${worktreesTable.hostId} END = ${worktreeId}`;
}

/**
 * Worktree-scoped data access layer (Phase 3 of the 3-tier refactor —
 * issue #314).
 *
 * Infra tier — owns the persistence concerns for the worktree domain:
 *
 *   - The `worktrees` table (rows synthesizing the one-worktree-per-branch
 *     model on top of git worktrees).
 *   - Per-worktree branch status (`branch_statuses` — git/CI columns
 *     driven by `branch-status-poller`).
 *
 * `worktree_statuses` rows (agent name/status/summary) are still co-managed
 * by the agent lifecycle in `lib/state.ts`; only the worktree-delete-side
 * cleanup lives here so the service layer can drive a worktree removal
 * through a single object. Promoting the rest of `worktree_statuses` into
 * this class is in scope for a follow-up alongside the agent / task tier
 * migration.
 *
 * NOTE: today's worktrees-table writes still go through the whole-tree
 * `saveState` rewrite in `lib/state.ts` (it deletes + reinserts the
 * `repos` + `worktrees` tables together inside one transaction). That
 * persistence model belongs to the repos domain and is owned by Phase 2
 * (`RepoQueries`, issue #313); until that ships, the worktree service
 * continues to call `loadState`/`saveState` for the table mutations and
 * this class only exposes the read-side and the status-table cleanup paths
 * the service needs.
 */
export class WorktreeQueries {
  /**
   * Resolve a worktree ID back to its on-disk identity (repo, branch,
   * worktree path) by scanning the `worktrees` table.
   *
   * The match expression mirrors `toWorktreeId(repo, name, hostId)`:
   *   `${repo}-${name.replaceAll("/", "-")}` plus `@${hostId}` off the local host
   * where `name` is the immutable worktree identity (see the `worktrees`
   * schema), NOT the live `branch`. SQLite's `REPLACE(str, "/", "-")` is
   * also a replace-all, so this is bit-identical to the JS computation.
   * Pushing the match down into SQL lets us read at most one row instead of
   * fanning out the repos + worktrees tree just to find a single
   * worktree (the previous `loadState()`-based implementation walked every
   * repo's worktree list to find the match in JS).
   *
   * The returned `branch` is the live git branch, still useful to callers
   * that want the current checkout — identity is by `name`, git ops by
   * `branch`.
   *
   * Called from two places today: the worktree-status upsert path in
   * `lib/state.ts::upsertWorktreeStatus` (via the private
   * `resolveWorktreeIdentity` helper, which delegates here so the SQL
   * lives in one place) and any future service caller that needs to map
   * an opaque `worktreeId` back to its on-disk worktree without
   * loading the full repo tree.
   *
   * TODO: `toWorktreeId`'s encoding is not injective — repo `foo-bar` +
   * name `main` and repo `foo` + name `bar/main` both serialize to
   * `foo-bar-main`. `.get()` returns whichever row SQLite finds first, and
   * the sanity check below cannot disambiguate (both candidates satisfy
   * it). Fixing this requires changing the worktree-id encoding, which is
   * a cross-cutting change tracked separately from this refactor.
   */
  findIdentity(worktreeId: string): WorktreeIdentity | null {
    const db = getDb();
    const row = db
      .select({
        repo: worktreesTable.repoName,
        name: worktreesTable.name,
        branch: worktreesTable.branch,
        worktreePath: worktreesTable.path,
        hostId: worktreesTable.hostId,
      })
      .from(worktreesTable)
      .where(WORKTREE_ID_MATCH(worktreeId))
      .get();
    // Use the `toWorktreeId` helper as a runtime sanity check in case the
    // helper's encoding ever evolves to disagree with the SQL above.
    if (row && toWorktreeId(row.repo, row.name, row.hostId) === worktreeId) {
      return { repo: row.repo, branch: row.branch, worktreePath: row.worktreePath };
    }
    return null;
  }

  /**
   * The host a worktree lives on, from `worktrees.host_id`. Null when no
   * worktree row matches the id.
   */
  findHostId(worktreeId: string): string | null {
    const row = getDb()
      .select({
        repo: worktreesTable.repoName,
        name: worktreesTable.name,
        hostId: worktreesTable.hostId,
      })
      .from(worktreesTable)
      .where(WORKTREE_ID_MATCH(worktreeId))
      .get();
    // Same sanity check as `findIdentity`.
    return row && toWorktreeId(row.repo, row.name, row.hostId) === worktreeId ? row.hostId : null;
  }

  /**
   * Delete the `branch_statuses` row for the given worktree.
   *
   * Called from the worktree remove path to clear the per-worktree git /
   * CI snapshot the dashboard reads. No-op if the row doesn't exist (the
   * poller may not have ticked yet for a freshly-created worktree).
   */
  deleteBranchStatus(worktreeId: string): void {
    const db = getDb();
    db.delete(branchStatusesTable).where(eq(branchStatusesTable.worktreeId, worktreeId)).run();
  }
}
