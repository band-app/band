import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const HOSTS_MIGRATION = "20261004002518_hosts";

// Runs the migrations that come before the hosts one against a temp DB, seeds old-shape
// rows, then applies the rest. Never touches the real ~/.band.
describe("hosts migration", () => {
  let tmp = "";
  let sqlite: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "band-hosts-migration-"));
    sqlite = new DatabaseSync(join(tmp, "band.db"));
    sqlite.exec("PRAGMA foreign_keys = ON");
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps existing data and defaults host_id to local", () => {
    const before = join(tmp, "migrations-before");
    cpSync(migrationsDir, before, { recursive: true });
    const names = readdirSync(before).filter((n) => /^\d/.test(n));
    expect(names).toContain(HOSTS_MIGRATION);
    // Stop before the hosts migration. Later ones can depend on its tables.
    for (const name of names.filter((n) => n >= HOSTS_MIGRATION)) {
      rmSync(join(before, name), { recursive: true });
    }

    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: before });

    // The seed uses the names from before the repo and worktree rename migration.
    sqlite.exec(`
      INSERT INTO projects (name, path, default_branch, sort_order) VALUES ('proj', '/repos/proj', 'main', 0);
      INSERT INTO worktrees (project_name, name, branch, path) VALUES ('proj', 'feat', 'feat', '/repos/proj-feat');
      INSERT INTO workspace_statuses (workspace_id, project, branch, worktree_path, updated_at)
        VALUES ('proj-feat', 'proj', 'feat', '/repos/proj-feat', 1);
      INSERT INTO usage_events (task_id, workspace_id, project, captured_at) VALUES ('t1', 'proj-feat', 'proj', 1);
      INSERT INTO usage_scan_state (workspace_id, agent_type, last_scanned_updated_at) VALUES ('proj-feat', 'claude', 5);
      INSERT INTO cronjobs (id, file_key, name, prompt, cron_expression, scope, created_at)
        VALUES ('c1', 'k', 'n', 'p', '* * * * *', 'project', 'now');
    `);

    migrate(db, { migrationsFolder: migrationsDir });

    const one = (sql: string) => sqlite.prepare(sql).all();
    for (const table of [
      "worktrees",
      "worktree_statuses",
      "usage_events",
      "usage_scan_state",
      "cronjobs",
    ]) {
      expect(one(`SELECT host_id FROM ${table}`), table).toEqual([{ host_id: "local" }]);
    }
    expect(one("SELECT id, name FROM cronjobs")).toEqual([{ id: "c1", name: "n" }]);
    expect(one("SELECT task_id FROM usage_events")).toEqual([{ task_id: "t1" }]);
    expect(one("SELECT id, name, mode, status FROM hosts")).toEqual([
      { id: "local", name: "Local", mode: "attached", status: "online" },
    ]);
    expect(one("SELECT repo_name, host_id, path FROM repo_hosts")).toEqual([
      { repo_name: "proj", host_id: "local", path: "/repos/proj" },
    ]);
    expect(one("SELECT path FROM repos")).toEqual([{ path: "/repos/proj" }]);
    expect(one("SELECT path FROM worktrees")).toEqual([{ path: "/repos/proj-feat" }]);
    expect(one("SELECT last_scanned_updated_at AS v FROM usage_scan_state")).toEqual([{ v: 5 }]);
  });
});
