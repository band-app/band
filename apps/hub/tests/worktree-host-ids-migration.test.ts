import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const MIGRATION = "20261010120000_worktree_host_ids";

// Runs every migration before the host-qualified id one against a temp DB, seeds rows keyed by the
// old `<repo>-<branch>` id, then applies the rest. Never touches the real ~/.band.
describe("worktree host ids migration", () => {
  let tmp = "";
  let sqlite: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "band-wt-host-ids-migration-"));
    sqlite = new DatabaseSync(join(tmp, "band.db"));
    sqlite.exec("PRAGMA foreign_keys = ON");
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps local ids and moves panel states (chats, terminals), client state and statuses of a worker worktree to its new id", () => {
    const before = join(tmp, "migrations-before");
    cpSync(migrationsDir, before, { recursive: true });
    const names = readdirSync(before).filter((n) => /^\d/.test(n));
    expect(names).toContain(MIGRATION);
    for (const name of names.filter((n) => n >= MIGRATION)) {
      rmSync(join(before, name), { recursive: true });
    }

    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: before });

    sqlite.exec(`
      INSERT INTO hosts (id, name, mode, status, created_at) VALUES ('h-mac', 'mac', 'attached', 'online', 1);
      INSERT INTO hosts (id, name, mode, status, created_at) VALUES ('h-box', 'box', 'attached', 'online', 1);
      INSERT INTO repos (name, path, default_branch, sort_order) VALUES ('band', '', 'main', 0);
      INSERT INTO repos (name, path, default_branch, sort_order) VALUES ('solo', '/repos/solo', 'main', 1);
      INSERT INTO worktrees (repo_name, name, branch, path, host_id) VALUES
        ('band', 'main', 'main', '/mac/band', 'h-mac'),
        ('band', 'main', 'main', '/box/band', 'h-box'),
        ('band', 'feat/x', 'feat/x', '/mac/band-x', 'h-mac'),
        ('solo', 'main', 'main', '/repos/solo', 'local');
      UPDATE worktrees SET origin_worktree_id = 'band-feat-x' WHERE path = '/box/band';
      INSERT INTO worktree_statuses (worktree_id, repo, branch, worktree_path, host_id, updated_at) VALUES
        ('band-main', 'band', 'main', '/box/band', 'h-box', 1),
        ('solo-main', 'solo', 'main', '/repos/solo', 'local', 1);
      INSERT INTO panel_states (id, worktree_id, panel_type, state, created_at, updated_at) VALUES
        ('chat-1', 'band-feat-x', 'chat', '{}', 1, 1),
        ('chat-2', 'band-main', 'chat', '{}', 1, 1),
        ('chat-3', 'solo-main', 'chat', '{}', 1, 1);
      INSERT INTO client_state (key, scope, worktree_id, value, version, updated_at) VALUES
        ('band-draft:band-feat-x', 'all', 'band-feat-x', '"hi"', 1, 1),
        ('band:term-split:band-feat-x:leaf1', 'all', 'band-feat-x', '1', 1, 1),
        ('band-draft:solo-main', 'all', 'solo-main', '"yo"', 1, 1);
    `);

    migrate(db, { migrationsFolder: migrationsDir });

    const rows = (sql: string) => sqlite.prepare(sql).all();
    // A status row keeps the host it was written for.
    expect(rows("SELECT worktree_id, host_id FROM worktree_statuses ORDER BY host_id")).toEqual([
      { worktree_id: "band-main@h-box", host_id: "h-box" },
      { worktree_id: "solo-main", host_id: "local" },
    ]);
    // Chats attach to the worktree on the lowest host id when the old id was shared, and to the
    // only worktree of that name otherwise. A local worktree keeps its id.
    expect(rows("SELECT id, worktree_id FROM panel_states ORDER BY id")).toEqual([
      { id: "chat-1", worktree_id: "band-feat-x@h-mac" },
      { id: "chat-2", worktree_id: "band-main@h-box" },
      { id: "chat-3", worktree_id: "solo-main" },
    ]);
    expect(rows("SELECT key, worktree_id FROM client_state ORDER BY key")).toEqual([
      { key: "band-draft:band-feat-x@h-mac", worktree_id: "band-feat-x@h-mac" },
      { key: "band-draft:solo-main", worktree_id: "solo-main" },
      { key: "band:term-split:band-feat-x@h-mac:leaf1", worktree_id: "band-feat-x@h-mac" },
    ]);
    expect(rows("SELECT origin_worktree_id AS o FROM worktrees WHERE path = '/box/band'")).toEqual([
      { o: "band-feat-x@h-mac" },
    ]);
    expect(rows("SELECT name FROM sqlite_master WHERE name = '_wt_id_map'")).toEqual([]);
  });
});
