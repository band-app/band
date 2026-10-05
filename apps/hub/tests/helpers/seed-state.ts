import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import * as schema from "../../src/server/infra/db/schema";

const migrationsFolder = join(import.meta.dirname, "../../src/server/infra/db/migrations");

interface WorktreeData {
  /**
   * Immutable worktree identity. Optional in tests — defaults to `branch`,
   * matching the create-time invariant. Pass an explicit value distinct
   * from `branch` to simulate a worktree whose git branch was switched
   * after creation.
   */
  name?: string;
  branch: string;
  path: string;
  head?: string;
  pinned?: boolean;
}

interface RepoData {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees?: WorktreeData[];
  label?: string;
  kind?: "git" | "plain";
  /**
   * Whether the repo has an `origin` remote. Optional; defaults to
   * `true` so tests that don't care about CI polling behavior continue
   * to mirror the schema default (see `RepoState.hasOrigin` and
   * issue #458).
   */
  hasOrigin?: boolean;
}

interface StateData {
  repos: RepoData[];
}

export function seedState(tmpHome: string, state: StateData): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });

  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });

  db.transaction((tx) => {
    for (let i = 0; i < state.repos.length; i++) {
      const repo = state.repos[i];
      tx.insert(schema.repos)
        .values({
          name: repo.name,
          path: repo.path,
          defaultBranch: repo.defaultBranch,
          label: repo.label ?? null,
          sortOrder: i,
          kind: repo.kind ?? "git",
          hasOrigin: repo.hasOrigin ?? true,
        })
        .run();

      for (const wt of repo.worktrees ?? []) {
        tx.insert(schema.worktrees)
          .values({
            repoName: repo.name,
            name: wt.name ?? wt.branch,
            branch: wt.branch,
            path: wt.path,
            head: wt.head ?? null,
            pinned: wt.pinned ?? false,
          })
          .run();
      }
    }
  });

  sqlite.close();
}

export interface WorktreeStatusData {
  worktreeId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  agentName?: string;
  agentStatus?: string;
  agentLastActivity?: string;
  agentSummary?: string;
  codingAgentId?: string;
  /**
   * Override `updated_at`. Defaults to `Date.now()`. Tests that assert
   * on `updated_at` advancement should seed an explicit value (e.g.
   * `0`) so they can compare against it without timing dependencies.
   */
  updatedAt?: number;
}

export function seedWorktreeStatuses(tmpHome: string, statuses: WorktreeStatusData[]): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });

  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });

  const now = Date.now();
  db.transaction((tx) => {
    for (const s of statuses) {
      tx.insert(schema.worktreeStatuses)
        .values({
          worktreeId: s.worktreeId,
          repo: s.repo,
          branch: s.branch,
          worktreePath: s.worktreePath,
          agentName: s.agentName ?? "claude-code",
          agentStatus: s.agentStatus ?? "waiting",
          agentLastActivity: s.agentLastActivity ?? "",
          agentSummary: s.agentSummary ?? null,
          codingAgentId: s.codingAgentId ?? null,
          updatedAt: s.updatedAt ?? now,
        })
        .run();
    }
  });

  sqlite.close();
}

export function seedSettings(tmpHome: string, settings: object): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  writeFileSync(join(bandDir, "settings.json"), JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Read a repo's persisted `kind` directly from the SQLite DB. Used by
 * the poller/sync-state integration tests to verify that
 * `syncWorktrees` actually wrote the self-healed kind to disk (the
 * inline re-detection inside `repos.list` returns the corrected
 * value in-memory regardless of persistence — this lets us distinguish
 * the two).
 */
export function readRepoKind(tmpHome: string, repoName: string): string | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite.prepare("SELECT kind FROM repos WHERE name = ?").get(repoName) as
      | { kind: string }
      | undefined;
    return row?.kind;
  } finally {
    sqlite.close();
  }
}

/**
 * Delete a worktree's row while no server is running, modelling a worktree
 * removed behind the server's back (another process, a crash mid-remove).
 * Only the row: remove the worktree from git and disk separately.
 */
export function deleteWorktree(tmpHome: string, repoName: string, name: string): void {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    sqlite.prepare("DELETE FROM worktrees WHERE repo_name = ? AND name = ?").run(repoName, name);
  } finally {
    sqlite.close();
  }
}

/**
 * Count rows in `branch_statuses` for a given worktreeId. Used to
 * verify the `branch-status-poller` skips plain repos (so no
 * branch-status row is ever written for their implicit worktree).
 */
export function countBranchStatusRows(tmpHome: string, worktreeId: string): number {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) as n FROM branch_statuses WHERE worktree_id = ?")
      .get(worktreeId) as { n: number };
    return row.n;
  } finally {
    sqlite.close();
  }
}
