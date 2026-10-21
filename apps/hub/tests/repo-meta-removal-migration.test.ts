// An install from before the meta repo flag was removed. The DB is migrated up to the step before
// `remove_repo_meta`, seeded with a meta repo and a worktree, then migrated forward and booted by
// a real hub. Everything lives in temp dirs, never in ~/.band.

import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "repo-meta-removal-secret";
const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const NEW_MIGRATION = readdirSync(migrationsDir).find((n) => n.endsWith("_remove_repo_meta")) ?? "";

interface RepoView {
  name: string;
  worktrees: Array<{ name: string }>;
}

let server: ServerHandle;
let hubHome: string;
let columnsAfter: string[] = [];

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

beforeAll(async () => {
  expect(NEW_MIGRATION).not.toBe("");
  hubHome = createTmpHome("band-repo-meta-removal-");

  const bandDir = join(hubHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  const before = join(hubHome, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  for (const name of readdirSync(before).filter((n) => /^\d/.test(n) && n >= NEW_MIGRATION)) {
    rmSync(join(before, name), { recursive: true });
  }
  const db = drizzle({ client: sqlite });
  migrate(db, { migrationsFolder: before });
  sqlite
    .prepare(
      "INSERT INTO repos (name, path, default_branch, sort_order, meta) VALUES ('notes', '', 'main', 0, 1)",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO worktrees (repo_name, name, branch, path) VALUES ('notes', 'main', 'main', '')",
    )
    .run();
  migrate(db, { migrationsFolder: migrationsDir });
  columnsAfter = (sqlite.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  sqlite.close();

  seedSettings(hubHome, { tokenSecret: TOKEN });
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

describe("upgrading an install that has a meta repo", () => {
  it("drops the column and keeps the repo and its worktree", async () => {
    expect(columnsAfter).not.toContain("meta");
    const { repos } = await q<{ repos: RepoView[] }>("repos.list");
    const notes = repos.find((r) => r.name === "notes");
    expect(notes?.worktrees.map((w) => w.name)).toEqual(["main"]);
  });

  it("returns no meta field from repos.list", async () => {
    const { repos } = await q<{ repos: Array<Record<string, unknown>> }>("repos.list");
    expect(repos.every((r) => !("meta" in r))).toBe(true);
  });

  it("ignores a meta field from an old client on repos.update", async () => {
    const res = await trpcMutate(server.url, "repos.update", { name: "notes", meta: true }, TOKEN);
    expect(res.status).toBe(200);
  });
});
