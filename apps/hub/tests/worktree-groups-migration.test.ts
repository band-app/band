// S1: an install from before worktree groups, with repo labels. The DB is migrated up to the step
// before `worktree_groups`, seeded with labelled repos, then migrated forward and booted by a real
// hub, with the labels still in settings.json. Everything lives in temp dirs, never in ~/.band.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "worktree-groups-migration-secret";
const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const NEW_MIGRATION = readdirSync(migrationsDir).find((n) => n.endsWith("_worktree_groups")) ?? "";

let server: ServerHandle;
let hubHome: string;
let dbPath: string;

const labels = [
  { id: "work", name: "Work", color: "#ff0000" },
  { id: "personal", name: "Personal", color: "#00ff00" },
];

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

interface Listed {
  groups: Array<{ id: string; name: string; color: string }>;
  repos: Array<{ name: string; worktrees: Array<{ name: string; groupId: string | null }> }>;
}

beforeAll(async () => {
  expect(NEW_MIGRATION).not.toBe("");
  hubHome = createTmpHome("band-groups-migration-");
  const bandDir = join(hubHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  dbPath = join(bandDir, "band.db");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const before = join(hubHome, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  for (const name of readdirSync(before).filter((n) => /^\d/.test(n) && n >= NEW_MIGRATION)) {
    rmSync(join(before, name), { recursive: true });
  }
  const db = drizzle({ client: sqlite });
  migrate(db, { migrationsFolder: before });
  const insertRepo = sqlite.prepare(
    "INSERT INTO repos (name, path, default_branch, label, sort_order) VALUES (?, ?, 'main', ?, ?)",
  );
  insertRepo.run("a", "", "work", 0);
  insertRepo.run("b", "", null, 1);
  // A label id that settings.json no longer defines.
  insertRepo.run("c", "", "gone", 2);
  const insertWt = sqlite.prepare(
    "INSERT INTO worktrees (repo_name, name, branch, path) VALUES (?, ?, ?, ?)",
  );
  for (const name of ["main", "one", "two"]) insertWt.run("a", name, name, `/nowhere/a-${name}`);
  insertWt.run("b", "main", "main", "/nowhere/b-main");
  insertWt.run("c", "main", "main", "/nowhere/c-main");
  const insertState = sqlite.prepare(
    "INSERT INTO client_state (key, scope, worktree_id, value, version, updated_at) VALUES (?, 'all', NULL, ?, 1, 1)",
  );
  insertState.run("band.repos-list.label-filter", '"work"');
  insertState.run("band.repos-list.collapsed-labels", '["personal"]');
  migrate(db, { migrationsFolder: migrationsDir });
  const cols = sqlite.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
  expect(cols.map((c) => c.name)).not.toContain("label");
  sqlite.close();

  seedSettings(hubHome, { tokenSecret: TOKEN, labels });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(hubHome, { recursive: true, force: true, maxRetries: 10 });
});

describe("upgrading an install that has repo labels", () => {
  it("turns each label into a group with the same id, name, color and order", async () => {
    const { groups } = await q<Listed>("repos.list");
    expect(groups).toEqual(labels);
    expect((await q<{ groups: Listed["groups"] }>("groups.list")).groups).toEqual(labels);
  });

  it("puts a labelled repo's worktrees in its group, keeps every row, and clears an unknown label", async () => {
    const { repos } = await q<Listed>("repos.list");
    const groupOf = (repo: string) =>
      repos.find((r) => r.name === repo)?.worktrees.map((w) => w.groupId);
    expect(groupOf("a")).toEqual(["work", "work", "work"]);
    expect(groupOf("b")).toEqual([null]);
    expect(groupOf("c")).toEqual([null]);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect((db.prepare("SELECT count(*) AS n FROM worktrees").get() as { n: number }).n).toBe(5);
    } finally {
      db.close();
    }
  });

  it("drops labels from settings.json and renames the client-state keys", async () => {
    const settings = JSON.parse(readFileSync(join(hubHome, ".band", "settings.json"), "utf8"));
    expect(settings.labels).toBeUndefined();
    expect(settings.tokenSecret).toBe(TOKEN);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT key, value FROM client_state ORDER BY key").all();
      expect(rows).toEqual([
        { key: "band.repos-list.collapsed-groups", value: '["personal"]' },
        { key: "band.repos-list.group-filter", value: '"work"' },
      ]);
    } finally {
      db.close();
    }
  });
});
