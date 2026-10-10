import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const RENAME_MIGRATION = "20261005190000_rename_repos_worktrees";

// Builds a DB as an install from before the rename left it (every migration except the rename
// one), seeds rows under the old table and column names, then applies the rename and reads the
// same rows back under the new names. It never touches the real ~/.band.
describe("repo and worktree rename migration", () => {
  let tmp = "";
  let sqlite: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "band-rename-migration-"));
    sqlite = new DatabaseSync(join(tmp, "band.db"));
    sqlite.exec("PRAGMA foreign_keys = ON");
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const all = (sql: string) => sqlite.prepare(sql).all();

  it("keeps every row and shows it under the new names", () => {
    const before = join(tmp, "migrations-before");
    cpSync(migrationsDir, before, { recursive: true });
    expect(readdirSync(before)).toContain(RENAME_MIGRATION);
    for (const name of readdirSync(before).filter((n) => n >= RENAME_MIGRATION)) {
      rmSync(join(before, name), { recursive: true });
    }

    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: before });

    sqlite.exec(`
      INSERT INTO projects (name, path, default_branch, sort_order, label) VALUES ('proj', '/repos/proj', 'main', 0, 'work');
      INSERT INTO worktrees (project_name, name, branch, path) VALUES ('proj', 'feat', 'feat', '/repos/proj-feat');
      INSERT INTO project_hosts (project_name, host_id, path) VALUES ('proj', 'local', '/repos/proj');
      INSERT INTO project_browser_profiles (project_name, profile_id, updated_at) VALUES ('proj', 'p1', 1);
      INSERT INTO workspace_statuses (workspace_id, project, branch, worktree_path, updated_at)
        VALUES ('proj-feat', 'proj', 'feat', '/repos/proj-feat', 1);
      INSERT INTO workspace_status_sources (workspace_id, source_id, status, updated_at)
        VALUES ('proj-feat', 'chat:c1', 'working', 1);
      INSERT INTO tasks (id, workspace_id, project, branch, prompt, status, started_at)
        VALUES ('t1', 'proj-feat', 'proj', 'feat', 'p', 'done', 1);
      INSERT INTO panel_states (id, workspace_id, panel_type, state, created_at, updated_at)
        VALUES ('c1', 'proj-feat', 'chat', '{}', 1, 1);
      INSERT INTO usage_events (task_id, workspace_id, project, captured_at) VALUES ('t1', 'proj-feat', 'proj', 1);
      INSERT INTO cronjobs (id, file_key, name, prompt, cron_expression, scope, workspace_id, created_at)
        VALUES ('cw', 'k1', 'n', 'p', '* * * * *', 'workspace', 'proj-feat', 'now');
      INSERT INTO cronjobs (id, file_key, name, prompt, cron_expression, scope, created_at)
        VALUES ('cp', 'k2', 'n', 'p', '* * * * *', 'project', 'now');
      INSERT INTO vault_items (id, name, kind, scope, encrypted, created_at, updated_at)
        VALUES ('v1', 'k', 'api_key', 'project:proj', 'x', 1, 1);
      INSERT INTO vault_items (id, name, kind, scope, encrypted, created_at, updated_at)
        VALUES ('v2', 'k', 'api_key', 'global', 'x', 1, 1);
      INSERT INTO client_state (key, scope, version, updated_at, value)
        VALUES ('band.projects-list.collapsed-projects', 'all', 1, 1, '["proj"]');
      INSERT INTO client_state (key, scope, version, updated_at, value)
        VALUES ('band:last-workspace', 'desktop', 1, 1, '"proj-feat"');
      INSERT INTO client_state (key, scope, version, updated_at, workspace_id, value)
        VALUES ('band-draft:proj-feat', 'all', 1, 1, 'proj-feat', '"hello"');
      INSERT INTO host_requests (id, workspace_id, project, branch, input, created_at, updated_at)
        VALUES ('r1', 'proj-feat', 'proj', 'feat', '{"project":"proj","branch":"feat","hostProjectPath":"/x"}', 1, 1);
      INSERT INTO mcp_servers (id, name, url, scope_projects, created_at, updated_at)
        VALUES ('m1', 'srv', 'https://example.com/mcp', '["proj"]', 1, 1);
    `);

    migrate(db, { migrationsFolder: migrationsDir });

    expect(all("SELECT name, path, label FROM repos")).toEqual([
      { name: "proj", path: "/repos/proj", label: "work" },
    ]);
    expect(all("SELECT repo_name, name, path FROM worktrees")).toEqual([
      { repo_name: "proj", name: "feat", path: "/repos/proj-feat" },
    ]);
    expect(all("SELECT repo_name, host_id, path FROM repo_hosts")).toEqual([
      { repo_name: "proj", host_id: "local", path: "/repos/proj" },
    ]);
    expect(all("SELECT repo_name, profile_id FROM repo_browser_profiles")).toEqual([
      { repo_name: "proj", profile_id: "p1" },
    ]);
    expect(all("SELECT worktree_id, repo FROM worktree_statuses")).toEqual([
      { worktree_id: "proj-feat", repo: "proj" },
    ]);
    expect(all("SELECT worktree_id, source_id FROM worktree_status_sources")).toEqual([
      { worktree_id: "proj-feat", source_id: "chat:c1" },
    ]);
    expect(all("SELECT worktree_id, repo FROM tasks")).toEqual([
      { worktree_id: "proj-feat", repo: "proj" },
    ]);
    expect(all("SELECT worktree_id, panel_type FROM panel_states")).toEqual([
      { worktree_id: "proj-feat", panel_type: "chat" },
    ]);
    expect(all("SELECT worktree_id, repo FROM usage_events")).toEqual([
      { worktree_id: "proj-feat", repo: "proj" },
    ]);
    expect(all("SELECT id, scope, worktree_id FROM cronjobs ORDER BY id")).toEqual([
      { id: "cp", scope: "repo", worktree_id: null },
      { id: "cw", scope: "worktree", worktree_id: "proj-feat" },
    ]);
    expect(all("SELECT id, scope FROM vault_items ORDER BY id")).toEqual([
      { id: "v1", scope: "repo:proj" },
      { id: "v2", scope: "global" },
    ]);
    expect(all("SELECT key, scope, value FROM client_state ORDER BY key")).toEqual([
      { key: "band-draft:proj-feat", scope: "all", value: '"hello"' },
      { key: "band.repos-list.collapsed-repos", scope: "all", value: '["proj"]' },
      { key: "band:last-worktree", scope: "desktop", value: '"proj-feat"' },
    ]);
    expect(all("SELECT worktree_id FROM client_state WHERE key = 'band-draft:proj-feat'")).toEqual([
      { worktree_id: "proj-feat" },
    ]);
    expect(all("SELECT worktree_id, repo, input FROM host_requests")).toEqual([
      {
        worktree_id: "proj-feat",
        repo: "proj",
        input: '{"repo":"proj","branch":"feat","hostRepoPath":"/x"}',
      },
    ]);
    expect(all("SELECT scope_repos FROM mcp_servers")).toEqual([{ scope_repos: '["proj"]' }]);

    // The old names are gone, and a repo still cascades to its worktrees.
    const names = all("SELECT name FROM sqlite_master WHERE type = 'table'").map(
      (r) => (r as { name: string }).name,
    );
    expect(names).not.toContain("projects");
    expect(names).not.toContain("project_hosts");
    expect(names).not.toContain("workspace_statuses");
    sqlite.exec("DELETE FROM repos WHERE name = 'proj'");
    expect(all("SELECT id FROM worktrees")).toEqual([]);
  });
});
