// Shared read helpers for integration tests that need to assert on the
// server's persisted `worktrees` rows. Reading straight from the same
// SQLite DB the server writes to keeps the assertion independent of an
// unrelated tRPC endpoint's behaviour — the same rationale
// `worktree-remove-detached.test.ts` documented when it first inlined
// these. Promoted here (issue: third inline copy across the suite) so
// the removal/reconcile tests share one definition.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Persisted `branch` values for a repo's worktrees, sorted. The
 * `branch` column tracks the live git branch (mutated by
 * `syncWorktrees`).
 */
export function listWorktreeBranches(tmpHome: string, repoName: string): string[] {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const rows = sqlite
      .prepare("SELECT branch FROM worktrees WHERE repo_name = ? ORDER BY branch")
      .all(repoName) as Array<{ branch: string }>;
    return rows.map((r) => r.branch);
  } finally {
    sqlite.close();
  }
}

/**
 * Persisted `name` (immutable worktree identity) values for a repo's
 * worktrees, sorted. Distinct from `branch`: `name` is frozen at create
 * time and never mutated by `syncWorktrees`, so it's the key removal
 * filters on.
 */
export function listWorktreeNames(tmpHome: string, repoName: string): string[] {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const rows = sqlite
      .prepare("SELECT name FROM worktrees WHERE repo_name = ? ORDER BY name")
      .all(repoName) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    sqlite.close();
  }
}

/** Persisted `default_branch` of a repo, or `undefined` when it has no row. */
export function readRepoDefaultBranch(tmpHome: string, repoName: string): string | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite.prepare("SELECT default_branch FROM repos WHERE name = ?").get(repoName) as
      | { default_branch: string }
      | undefined;
    return row?.default_branch;
  } finally {
    sqlite.close();
  }
}
