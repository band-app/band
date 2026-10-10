import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../connection";
import {
  repoHosts as repoHostsTable,
  repos as reposTable,
  worktrees as worktreesTable,
} from "../schema";

/**
 * Repo data access — Phase 2 of the 3-tier refactor
 * (`docs/web-architecture.md`).
 *
 * Owns the `repos` + `worktrees` tables. The old whole-tree
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
 * Repo kind. "git" repos use git worktrees for per-worktree
 * isolation; "plain" repos have a single implicit worktree whose
 * path equals the repo path — no isolation, no branch, git-specific
 * features disabled.
 */
export type RepoKind = "git" | "plain";

/**
 * In-memory representation of a repo row plus its worktree children.
 *
 * Callers mutate this freely and then re-persist the entire tree via
 * `RepoQueries.saveAll`. The hot-path single-column `hasOrigin` update
 * uses `setHasOrigin` instead so it doesn't race the whole-tree rewrite.
 */
export interface RepoState {
  name: string;
  /** The folder on the hub's own machine, or "" when the hub has no checkout of the repo. */
  path: string;
  /** The `origin` URL without credentials. Absent for a plain folder or a repo with no remote. */
  remoteUrl?: string;
  /** `normalizeRemoteUrl(remoteUrl)`, the identity a worker maps to a folder. */
  remoteKey?: string;
  defaultBranch: string;
  worktrees: WorktreeState[];
  label?: string;
  kind: RepoKind;
  /**
   * Whether the repo's git repo has an `origin` remote.
   *
   * Populated by `syncWorktrees` at the CI tick cadence and used by
   * `branch-status-poller` to skip the CI / `getRepoInfo` query for
   * origin-less repos — that's an expected steady state for some
   * repos and the query just produces log noise (issue #458).
   *
   * Defaults to `true` for plain (non-git) repos and for freshly
   * added repos that sync hasn't reached yet, so the first CI tick
   * after boot still issues the query. The real value lands on the
   * next sync pass and sticks until the remote configuration changes.
   */
  hasOrigin: boolean;
}

/**
 * One worktree under a repo. Plain repos synthesize a single
 * worktree at `{name: "main", branch: "main", path: repo.path}`.
 */
export interface WorktreeState {
  /**
   * Immutable worktree identity — the (slugified) branch name captured at
   * creation. The worktree id derives from this (`toWorktreeId`), so it
   * is stable across git branch switches. Never mutated by `syncWorktrees`.
   */
  name: string;
  /** Live git branch checked out in the worktree. Synced against git. */
  branch: string;
  path: string;
  head?: string;
  pinned: boolean;
  /** Host the worktree lives on. Absent means `local`. */
  hostId?: string;
}

/**
 * Re-detect `kind` from the filesystem and reconcile the in-memory
 * repo row IN PLACE. The function always mutates `repo.kind`
 * (and `repo.worktrees` on a `git → plain` flip) when the
 * detected value disagrees with the stored one — the caller's only
 * decision is whether to flush the mutated row to disk.
 *
 * Today two call sites share this: `syncWorktrees` propagates the
 * return value into its `changed` flag and persists via the
 * whole-tree `saveAll` at the end of the loop; the inline path in
 * `repos.list` discards the return value and lets the next sync
 * tick persist.
 *
 * Returns `true` when the row was mutated, `false` otherwise.
 *
 * Lives in the Infra tier (not the service) because both the
 * sync-state poller and the back-compat `lib/state.ts` re-export need
 * to reach it without pulling in the higher service layer.
 */
export function reconcileKindForRepo(repo: RepoState): boolean {
  // Skip rows whose path no longer exists — leave kind alone rather
  // than synthesize a worktree under a missing directory. A repo the hub holds no checkout of
  // has no path to look at.
  if (!repo.path || !existsSync(repo.path)) return false;
  // `existsSync(.git)` returns true for both directories AND files. Git
  // submodules and secondary worktrees embed a `.git` file (rather
  // than a directory) that points at the parent repo — we want those
  // classified as "git" too.
  const detectedKind: RepoKind = existsSync(join(repo.path, ".git")) ? "git" : "plain";
  if (detectedKind === repo.kind) return false;

  repo.kind = detectedKind;
  // On a `git → plain` flip (`.git` disappeared from under us — e.g. a
  // `rm -rf .git` from a terminal), replace any existing worktree
  // rows with the implicit `{branch: "main", path: repo.path}`
  // worktree. We do this unconditionally for `plain` (not only when
  // worktrees is empty) because a real git repo flipping to plain
  // will still have its old `feat/foo` / `fix/bar` entries; leaving
  // them would orphan the rows (their worktree paths under
  // `worktreesDir/{repo}/{branch}` are now broken git worktrees
  // with no `.git` to reach back to) and the flattened plain UI would
  // render the wrong branch label.
  if (detectedKind === "plain") {
    repo.worktrees = [{ name: "main", branch: "main", path: repo.path, pinned: false }];
  }
  return true;
}

/**
 * Drizzle-backed data access for the `repos` and `worktrees` tables.
 *
 * Two write shapes:
 *   - `saveAll(repos)` — whole-tree DELETE + re-INSERT inside a
 *     transaction. The right primitive when worktrees / defaultBranch /
 *     labels / sort order change in batch (`repos.add`,
 *     `worktrees.create`, `syncWorktrees`).
 *   - `setHasOrigin(name, hasOrigin)` — focused single-column UPDATE that
 *     does NOT touch the worktrees table. Used by `syncWorktrees` to flip
 *     the `hasOrigin` flag without racing concurrent `worktrees.create`
 *     traffic. See `setHasOrigin` JSDoc for the full motivation.
 */
export class RepoQueries {
  /**
   * Read every repo + worktree row and assemble the in-memory tree.
   * Rows are ordered by `sortOrder` so callers preserve user-controlled
   * repo ordering in the dashboard.
   */
  loadAll(): RepoState[] {
    const db = getDb();
    const repoRows = db.select().from(reposTable).orderBy(reposTable.sortOrder).all();

    const worktreeRows = db.select().from(worktreesTable).all();

    const wtByRepo = new Map<string, WorktreeState[]>();
    for (const row of worktreeRows) {
      const list = wtByRepo.get(row.repoName) ?? [];
      list.push({
        // Defensive `|| branch`: a row written before the `name` column
        // existed (backfilled by migration) should never be empty, but fall
        // back to branch so identity stays stable even if it somehow is.
        name: row.name || row.branch,
        branch: row.branch,
        path: row.path,
        head: row.head ?? undefined,
        pinned: row.pinned,
        hostId: row.hostId,
      });
      wtByRepo.set(row.repoName, list);
    }

    return repoRows.map((row) => ({
      name: row.name,
      path: row.path,
      ...(row.remoteUrl ? { remoteUrl: row.remoteUrl } : {}),
      ...(row.remoteKey ? { remoteKey: row.remoteKey } : {}),
      defaultBranch: row.defaultBranch,
      label: row.label ?? undefined,
      kind: (row.kind ?? "git") as RepoKind,
      hasOrigin: row.hasOrigin,
      worktrees: wtByRepo.get(row.name) ?? [],
    }));
  }

  /**
   * Whole-tree rewrite of `repos` + `worktrees` from the supplied
   * in-memory snapshot. Wrapped in a transaction so a partial failure
   * leaves the previous state intact rather than orphaning worktree rows
   * after the repos table was truncated.
   *
   * Concurrency note: this races against any single-column UPDATE that
   * targets the same rows (e.g. `setHasOrigin`). Callers that only need
   * to update a focused column should use the corresponding instance
   * method rather than rewriting the whole tree — see `setHasOrigin`
   * for the canonical example.
   */
  saveAll(repos: RepoState[]): void {
    const db = getDb();

    db.transaction((tx) => {
      // Deleting a repo cascades to its `repo_hosts` rows. Keep the ones
      // for remote hosts, which the whole-tree rewrite knows nothing about.
      const remoteCheckouts = tx
        .select()
        .from(repoHostsTable)
        .where(ne(repoHostsTable.hostId, "local"))
        .all();
      tx.delete(worktreesTable).run();
      tx.delete(reposTable).run();

      for (let i = 0; i < repos.length; i++) {
        const repo = repos[i];
        tx.insert(reposTable)
          .values({
            name: repo.name,
            path: repo.path,
            remoteUrl: repo.remoteUrl ?? null,
            remoteKey: repo.remoteKey ?? null,
            defaultBranch: repo.defaultBranch,
            label: repo.label ?? null,
            sortOrder: i,
            kind: repo.kind,
            hasOrigin: repo.hasOrigin,
          })
          .run();

        for (const wt of repo.worktrees) {
          tx.insert(worktreesTable)
            .values({
              repoName: repo.name,
              name: wt.name,
              branch: wt.branch,
              path: wt.path,
              head: wt.head ?? null,
              pinned: wt.pinned,
              hostId: wt.hostId ?? "local",
            })
            .run();
        }

        if (repo.path) {
          tx.insert(repoHostsTable)
            .values({ repoName: repo.name, hostId: "local", path: repo.path })
            .run();
        }
        for (const checkout of remoteCheckouts) {
          if (checkout.repoName === repo.name) {
            tx.insert(repoHostsTable).values(checkout).run();
          }
        }
      }
    });
  }

  /** The repo's checkout path on a host, or null when the repo has no checkout there. */
  findHostPath(repoName: string, hostId: string): string | null {
    const row = getDb()
      .select({ path: repoHostsTable.path })
      .from(repoHostsTable)
      .where(and(eq(repoHostsTable.repoName, repoName), eq(repoHostsTable.hostId, hostId)))
      .get();
    return row?.path ?? null;
  }

  /**
   * The repos placed on a host: those with a checkout recorded there and those with a
   * worktree there. `path` is a directory of the repo's repository on that host.
   */
  reposOnHost(hostId: string): { repo: string; path: string }[] {
    const db = getDb();
    const out = new Map<string, string>();
    for (const row of db
      .select({ repo: worktreesTable.repoName, path: worktreesTable.path })
      .from(worktreesTable)
      .where(eq(worktreesTable.hostId, hostId))
      .all()) {
      out.set(row.repo, row.path);
    }
    for (const row of db
      .select({ repo: repoHostsTable.repoName, path: repoHostsTable.path })
      .from(repoHostsTable)
      .where(eq(repoHostsTable.hostId, hostId))
      .all()) {
      out.set(row.repo, row.path);
    }
    return [...out].map(([repo, path]) => ({ repo, path }));
  }

  /** Records where the repo's checkout lives on a host. Replaces an earlier path. */
  setHostPath(repoName: string, hostId: string, path: string): void {
    // The hub's own folder is also `repos.path`, which every local reader uses.
    if (hostId === "local") {
      getDb().update(reposTable).set({ path }).where(eq(reposTable.name, repoName)).run();
    }
    getDb()
      .insert(repoHostsTable)
      .values({ repoName, hostId, path })
      .onConflictDoUpdate({
        target: [repoHostsTable.repoName, repoHostsTable.hostId],
        set: { path },
      })
      .run();
  }

  /** Stores the remote a repo was found to have. Does not touch worktrees. */
  setRemote(name: string, remoteUrl: string, remoteKey: string): void {
    getDb().update(reposTable).set({ remoteUrl, remoteKey }).where(eq(reposTable.name, name)).run();
  }

  /** Forgets where a host keeps the repo. For the local host the repo has no hub checkout afterwards. */
  clearHostPath(repoName: string, hostId: string): void {
    if (hostId === "local") {
      getDb().update(reposTable).set({ path: "" }).where(eq(reposTable.name, repoName)).run();
    }
    getDb()
      .delete(repoHostsTable)
      .where(and(eq(repoHostsTable.repoName, repoName), eq(repoHostsTable.hostId, hostId)))
      .run();
  }

  /** Every host's recorded folder for each repo: `repo name -> host id -> path`. */
  allHostPaths(): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    for (const row of getDb().select().from(repoHostsTable).all()) {
      const hosts = out.get(row.repoName) ?? new Map<string, string>();
      hosts.set(row.hostId, row.path);
      out.set(row.repoName, hosts);
    }
    return out;
  }

  /** Replaces what a worker reported: the folder of each repo it holds, by remote key. */
  replaceWorkerMappings(hostId: string, mappings: { key: string; path: string }[]): void {
    const db = getDb();
    db.transaction((tx) => {
      const byKey = new Map<string, string[]>();
      for (const r of tx
        .select({ name: reposTable.name, key: reposTable.remoteKey })
        .from(reposTable)
        .all()) {
        if (!r.key) continue;
        byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.name]);
      }
      for (const m of mappings) {
        for (const repoName of byKey.get(m.key) ?? []) {
          tx.insert(repoHostsTable)
            .values({ repoName, hostId, path: m.path })
            .onConflictDoUpdate({
              target: [repoHostsTable.repoName, repoHostsTable.hostId],
              set: { path: m.path },
            })
            .run();
        }
      }
    });
  }

  /**
   * Targeted UPDATE for `repos.has_origin` only — does NOT go through
   * the whole-tree `saveAll` rewrite.
   *
   * `saveAll` deletes every row in `repos` + `worktrees` and re-inserts
   * from its in-memory snapshot. That's fine for the existing "worktrees /
   * defaultBranch changed" path (it carries the latest worktree list), but
   * it races badly with concurrent `worktrees.create` / `worktrees.remove`
   * traffic for the new "hasOrigin changed" path: a stale `syncWorktrees`
   * copy would clobber a just-saved worktree. Doing the hasOrigin update
   * as a focused single-column UPDATE sidesteps the issue — the worktrees
   * table is untouched. See issue #458.
   */
  setHasOrigin(name: string, hasOrigin: boolean): void {
    const db = getDb();
    db.update(reposTable).set({ hasOrigin }).where(eq(reposTable.name, name)).run();
  }

  /**
   * Path and kind of one repo, by primary key. For per-request lookups
   * (e.g. the avatar route) that don't need the worktree tree `loadAll`
   * assembles.
   */
  findLocation(
    name: string,
  ): { path: string; kind: RepoKind; defaultBranch: string; remoteUrl?: string } | undefined {
    const db = getDb();
    const row = db
      .select({
        remoteUrl: reposTable.remoteUrl,
        path: reposTable.path,
        kind: reposTable.kind,
        defaultBranch: reposTable.defaultBranch,
      })
      .from(reposTable)
      .where(eq(reposTable.name, name))
      .get();
    return row
      ? {
          path: row.path,
          kind: (row.kind ?? "git") as RepoKind,
          defaultBranch: row.defaultBranch,
          ...(row.remoteUrl ? { remoteUrl: row.remoteUrl } : {}),
        }
      : undefined;
  }
}
