import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { toWorkspaceId } from "../../src/dashboard";
import * as schema from "../../src/server/infra/db/schema";

const migrationsFolder = join(import.meta.dirname, "../../src/server/infra/db/migrations");

interface WorktreeData {
  branch: string;
  path: string;
  head?: string;
  pinned?: boolean;
  /**
   * Stable workspace id. Defaults to the canonical `toWorkspaceId(project,
   * branch)` value the server would mint at creation — matching the
   * migration backfill — so existing seeds need no change. Set this
   * explicitly to simulate a worktree whose branch was switched after
   * creation (id frozen at the original branch, `branch` now different).
   */
  workspaceId?: string;
}

interface ProjectData {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees?: WorktreeData[];
  label?: string;
  kind?: "git" | "plain";
  /**
   * Whether the project has an `origin` remote. Optional; defaults to
   * `true` so tests that don't care about CI polling behavior continue
   * to mirror the schema default (see `ProjectState.hasOrigin` and
   * issue #458).
   */
  hasOrigin?: boolean;
}

interface StateData {
  projects: ProjectData[];
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
    for (let i = 0; i < state.projects.length; i++) {
      const project = state.projects[i];
      tx.insert(schema.projects)
        .values({
          name: project.name,
          path: project.path,
          defaultBranch: project.defaultBranch,
          label: project.label ?? null,
          sortOrder: i,
          kind: project.kind ?? "git",
          hasOrigin: project.hasOrigin ?? true,
        })
        .run();

      for (const wt of project.worktrees ?? []) {
        tx.insert(schema.worktrees)
          .values({
            projectName: project.name,
            workspaceId: wt.workspaceId ?? toWorkspaceId(project.name, wt.branch),
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

export interface WorkspaceStatusData {
  workspaceId: string;
  project: string;
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

export function seedWorkspaceStatuses(tmpHome: string, statuses: WorkspaceStatusData[]): void {
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
      tx.insert(schema.workspaceStatuses)
        .values({
          workspaceId: s.workspaceId,
          project: s.project,
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
 * Read a project's persisted `kind` directly from the SQLite DB. Used by
 * the poller/sync-state integration tests to verify that
 * `syncWorktrees` actually wrote the self-healed kind to disk (the
 * inline re-detection inside `projects.list` returns the corrected
 * value in-memory regardless of persistence — this lets us distinguish
 * the two).
 */
export function readProjectKind(tmpHome: string, projectName: string): string | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite.prepare("SELECT kind FROM projects WHERE name = ?").get(projectName) as
      | { kind: string }
      | undefined;
    return row?.kind;
  } finally {
    sqlite.close();
  }
}

/**
 * Count rows in `branch_statuses` for a given workspaceId. Used to
 * verify the `branch-status-poller` skips plain projects (so no
 * branch-status row is ever written for their implicit workspace).
 */
export function countBranchStatusRows(tmpHome: string, workspaceId: string): number {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) as n FROM branch_statuses WHERE workspace_id = ?")
      .get(workspaceId) as { n: number };
    return row.n;
  } finally {
    sqlite.close();
  }
}
