// Shared read helpers for integration tests that need to assert on the
// server's persisted `worktrees` rows. Reading straight from the same
// SQLite DB the server writes to keeps the assertion independent of an
// unrelated tRPC endpoint's behaviour — the same rationale
// `workspace-remove-detached.test.ts` documented when it first inlined
// these. Promoted here (issue: third inline copy across the suite) so
// the removal/reconcile tests share one definition.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Persisted `branch` values for a project's worktrees, sorted. The
 * `branch` column tracks the live git branch (mutated by
 * `syncWorktrees`).
 */
export function listWorktreeBranches(tmpHome: string, projectName: string): string[] {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const rows = sqlite
      .prepare("SELECT branch FROM worktrees WHERE project_name = ? ORDER BY branch")
      .all(projectName) as Array<{ branch: string }>;
    return rows.map((r) => r.branch);
  } finally {
    sqlite.close();
  }
}

/**
 * Persisted `name` (immutable workspace identity) values for a project's
 * worktrees, sorted. Distinct from `branch`: `name` is frozen at create
 * time and never mutated by `syncWorktrees`, so it's the key removal
 * filters on.
 */
export function listWorktreeNames(tmpHome: string, projectName: string): string[] {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const rows = sqlite
      .prepare("SELECT name FROM worktrees WHERE project_name = ? ORDER BY name")
      .all(projectName) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    sqlite.close();
  }
}
