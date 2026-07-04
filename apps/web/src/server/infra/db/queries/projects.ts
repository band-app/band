import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { projects as projectsTable, worktrees as worktreesTable } from "../schema";

/**
 * Project data access — Phase 2 of the 3-tier refactor
 * (`docs/web-architecture.md`).
 *
 * Owns the `projects` + `worktrees` tables. The old whole-tree
 * `loadState` / `saveState` pair used to live in `lib/state.ts`; that
 * module now re-exports the helpers below as thin shims so existing
 * callers (chat-manager, agent-pool, branch-status-poller, sync-state)
 * keep compiling while subsequent refactor phases migrate each caller
 * to use this class directly.
 *
 * Infra-tier rules:
 *   - knows nothing about services, routers, or git
 *   - only depends on Drizzle + Node primitives
 *   - returns plain data (typed rows / state objects) — no business
 *     decisions about what to do with it
 */

/**
 * Project kind. "git" projects use git worktrees for per-workspace
 * isolation; "plain" projects have a single implicit workspace whose
 * path equals the project path — no isolation, no branch, git-specific
 * features disabled.
 */
export type ProjectKind = "git" | "plain";

/**
 * In-memory representation of a project row plus its worktree children.
 *
 * Callers mutate this freely and then re-persist the entire tree via
 * `ProjectQueries.saveAll`. The hot-path single-column `hasOrigin` update
 * uses `setHasOrigin` instead so it doesn't race the whole-tree rewrite.
 */
export interface ProjectState {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeState[];
  label?: string;
  kind: ProjectKind;
  /**
   * Whether the project's git repo has an `origin` remote.
   *
   * Populated by `syncWorktrees` at the CI tick cadence and used by
   * `branch-status-poller` to skip the CI / `getRepoInfo` query for
   * origin-less repos — that's an expected steady state for some
   * projects and the query just produces log noise (issue #458).
   *
   * Defaults to `true` for plain (non-git) projects and for freshly
   * added projects that sync hasn't reached yet, so the first CI tick
   * after boot still issues the query. The real value lands on the
   * next sync pass and sticks until the remote configuration changes.
   */
  hasOrigin: boolean;
}

/**
 * One worktree under a project. Plain projects synthesize a single
 * worktree at `{name: "main", branch: "main", path: project.path}`.
 */
export interface WorktreeState {
  /**
   * Immutable workspace identity — the (slugified) branch name captured at
   * creation. The workspace id derives from this (`toWorkspaceId`), so it
   * is stable across git branch switches. Never mutated by `syncWorktrees`.
   */
  name: string;
  /** Live git branch checked out in the worktree. Synced against git. */
  branch: string;
  path: string;
  head?: string;
  pinned: boolean;
}

/**
 * Re-detect `kind` from the filesystem and reconcile the in-memory
 * project row IN PLACE. The function always mutates `project.kind`
 * (and `project.worktrees` on a `git → plain` flip) when the
 * detected value disagrees with the stored one — the caller's only
 * decision is whether to flush the mutated row to disk.
 *
 * Today two call sites share this: `syncWorktrees` propagates the
 * return value into its `changed` flag and persists via the
 * whole-tree `saveAll` at the end of the loop; the inline path in
 * `projects.list` discards the return value and lets the next sync
 * tick persist.
 *
 * Returns `true` when the row was mutated, `false` otherwise.
 *
 * Lives in the Infra tier (not the service) because both the
 * sync-state poller and the back-compat `lib/state.ts` re-export need
 * to reach it without pulling in the higher service layer.
 */
export function reconcileKindForProject(project: ProjectState): boolean {
  // Skip rows whose path no longer exists — leave kind alone rather
  // than synthesize a workspace under a missing directory.
  if (!existsSync(project.path)) return false;
  // `existsSync(.git)` returns true for both directories AND files. Git
  // submodules and secondary worktrees embed a `.git` file (rather
  // than a directory) that points at the parent repo — we want those
  // classified as "git" too.
  const detectedKind: ProjectKind = existsSync(join(project.path, ".git")) ? "git" : "plain";
  if (detectedKind === project.kind) return false;

  project.kind = detectedKind;
  // On a `git → plain` flip (`.git` disappeared from under us — e.g. a
  // `rm -rf .git` from a terminal), replace any existing worktree
  // rows with the implicit `{branch: "main", path: project.path}`
  // workspace. We do this unconditionally for `plain` (not only when
  // worktrees is empty) because a real git project flipping to plain
  // will still have its old `feat/foo` / `fix/bar` entries; leaving
  // them would orphan the rows (their worktree paths under
  // `worktreesDir/{project}/{branch}` are now broken git worktrees
  // with no `.git` to reach back to) and the flattened plain UI would
  // render the wrong branch label.
  if (detectedKind === "plain") {
    project.worktrees = [{ name: "main", branch: "main", path: project.path, pinned: false }];
  }
  return true;
}

/**
 * Drizzle-backed data access for the `projects` and `worktrees` tables.
 *
 * Two write shapes:
 *   - `saveAll(projects)` — whole-tree DELETE + re-INSERT inside a
 *     transaction. The right primitive when worktrees / defaultBranch /
 *     labels / sort order change in batch (`projects.add`,
 *     `workspaces.create`, `syncWorktrees`).
 *   - `setHasOrigin(name, hasOrigin)` — focused single-column UPDATE that
 *     does NOT touch the worktrees table. Used by `syncWorktrees` to flip
 *     the `hasOrigin` flag without racing concurrent `workspaces.create`
 *     traffic. See `setHasOrigin` JSDoc for the full motivation.
 */
export class ProjectQueries {
  /**
   * Read every project + worktree row and assemble the in-memory tree.
   * Rows are ordered by `sortOrder` so callers preserve user-controlled
   * project ordering in the dashboard.
   */
  loadAll(): ProjectState[] {
    const db = getDb();
    const projectRows = db.select().from(projectsTable).orderBy(projectsTable.sortOrder).all();

    const worktreeRows = db.select().from(worktreesTable).all();

    const wtByProject = new Map<string, WorktreeState[]>();
    for (const row of worktreeRows) {
      const list = wtByProject.get(row.projectName) ?? [];
      list.push({
        // Defensive `|| branch`: a row written before the `name` column
        // existed (backfilled by migration) should never be empty, but fall
        // back to branch so identity stays stable even if it somehow is.
        name: row.name || row.branch,
        branch: row.branch,
        path: row.path,
        head: row.head ?? undefined,
        pinned: row.pinned,
      });
      wtByProject.set(row.projectName, list);
    }

    return projectRows.map((row) => ({
      name: row.name,
      path: row.path,
      defaultBranch: row.defaultBranch,
      label: row.label ?? undefined,
      kind: (row.kind ?? "git") as ProjectKind,
      hasOrigin: row.hasOrigin,
      worktrees: wtByProject.get(row.name) ?? [],
    }));
  }

  /**
   * Whole-tree rewrite of `projects` + `worktrees` from the supplied
   * in-memory snapshot. Wrapped in a transaction so a partial failure
   * leaves the previous state intact rather than orphaning worktree rows
   * after the projects table was truncated.
   *
   * Concurrency note: this races against any single-column UPDATE that
   * targets the same rows (e.g. `setHasOrigin`). Callers that only need
   * to update a focused column should use the corresponding instance
   * method rather than rewriting the whole tree — see `setHasOrigin`
   * for the canonical example.
   */
  saveAll(projects: ProjectState[]): void {
    const db = getDb();

    db.transaction((tx) => {
      tx.delete(worktreesTable).run();
      tx.delete(projectsTable).run();

      for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        tx.insert(projectsTable)
          .values({
            name: project.name,
            path: project.path,
            defaultBranch: project.defaultBranch,
            label: project.label ?? null,
            sortOrder: i,
            kind: project.kind,
            hasOrigin: project.hasOrigin,
          })
          .run();

        for (const wt of project.worktrees) {
          tx.insert(worktreesTable)
            .values({
              projectName: project.name,
              name: wt.name,
              branch: wt.branch,
              path: wt.path,
              head: wt.head ?? null,
              pinned: wt.pinned,
            })
            .run();
        }
      }
    });
  }

  /**
   * Targeted UPDATE for `projects.has_origin` only — does NOT go through
   * the whole-tree `saveAll` rewrite.
   *
   * `saveAll` deletes every row in `projects` + `worktrees` and re-inserts
   * from its in-memory snapshot. That's fine for the existing "worktrees /
   * defaultBranch changed" path (it carries the latest worktree list), but
   * it races badly with concurrent `workspaces.create` / `workspaces.remove`
   * traffic for the new "hasOrigin changed" path: a stale `syncWorktrees`
   * copy would clobber a just-saved worktree. Doing the hasOrigin update
   * as a focused single-column UPDATE sidesteps the issue — the worktrees
   * table is untouched. See issue #458.
   */
  setHasOrigin(name: string, hasOrigin: boolean): void {
    const db = getDb();
    db.update(projectsTable).set({ hasOrigin }).where(eq(projectsTable.name, name)).run();
  }
}
