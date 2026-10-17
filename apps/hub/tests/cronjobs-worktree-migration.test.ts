// An install from before cronjobs belonged to a worktree. The DB is migrated up to the step before
// `cronjob_session`, seeded with repo-scoped jobs, then migrated forward and booted by a real hub.
// Everything lives in temp dirs, never in ~/.band.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { STUB_AGENT_PATH, TEST_TOKEN, trpc, writeStubScenario } from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const NEW_MIGRATION = readdirSync(migrationsDir).find((n) => n.endsWith("_cronjob_session")) ?? "";

interface Job {
  id: string;
  name: string;
  prompt: string;
  cronExpression: string;
  scope: string;
  worktreeId?: string;
  fileKey: string;
  enabled: boolean;
  via: string;
  lastRunStatus?: string;
  lastRunMessage?: string;
}

const scratch: string[] = [];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function makeRepo(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

let home: string;
let server: ServerHandle;

const jobs = async () =>
  (await trpc<{ jobs: Job[] }>(server.url, "cronjobs.list", {}, "query")).jobs;

beforeAll(async () => {
  expect(NEW_MIGRATION).not.toBe("");
  home = createTmpHome("band-cron-worktree-migration-");
  const checkouts = realpathSync(
    mkdtempSync(join(tmpdir(), "band-cron-worktree-migration-repos-")),
  );
  scratch.push(checkouts);
  const app = join(checkouts, "app");
  // `nomain` has `main` as its default branch, but its only checkout is on `other`.
  const nomain = join(checkouts, "nomain");
  makeRepo(app, "main");
  makeRepo(nomain, "other");

  const bandDir = join(home, ".band");
  mkdirSync(bandDir, { recursive: true });
  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  const before = join(home, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  for (const name of readdirSync(before).filter((n) => /^\d/.test(n) && n >= NEW_MIGRATION)) {
    rmSync(join(before, name), { recursive: true });
  }
  const db = drizzle({ client: sqlite });
  migrate(db, { migrationsFolder: before });

  const insertRepo = sqlite.prepare(
    "INSERT INTO repos (name, path, default_branch, sort_order) VALUES (?, ?, 'main', ?)",
  );
  insertRepo.run("app", app, 0);
  insertRepo.run("nomain", nomain, 1);
  const insertWt = sqlite.prepare(
    "INSERT INTO worktrees (repo_name, name, branch, path) VALUES (?, ?, ?, ?)",
  );
  insertWt.run("app", "main", "main", app);
  insertWt.run("nomain", "other", "other", nomain);

  const insertJob = sqlite.prepare(
    `INSERT INTO cronjobs (id, file_key, name, prompt, cron_expression, scope, via, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 'repo', ?, ?, '2026-01-01T00:00:00.000Z')`,
  );
  insertJob.run("cj_old_app", "app", "App nightly", "nightly prompt", "0 3 * * *", "chat", 1);
  insertJob.run("cj_old_off", "app", "App paused", "paused prompt", "0 4 * * *", "chat", 0);
  insertJob.run("cj_old_nomain", "nomain", "No main", "never fires", "0 5 * * *", "chat", 1);
  insertJob.run("cj_old_ghost", "ghost", "Gone repo", "never fires", "0 6 * * *", "chat", 1);
  // The chat the old repo job already writes into.
  sqlite
    .prepare(
      "INSERT INTO panel_states (id, worktree_id, panel_type, state, labels, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?, 1, 1)",
    )
    .run(
      "chat_old_cron",
      "app-main",
      JSON.stringify({ name: "App nightly", agent: "claude-code", status: "idle" }),
      JSON.stringify({ "band:cronId": "cj_old_app" }),
    );
  migrate(db, { migrationsFolder: migrationsDir });
  sqlite.close();

  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  // The jobs name the hub's own checkouts, so this server stays off the loopback worker.
  server = await startServer({
    tmpHome: home,
    remoteHost: false,
    env: {
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      BAND_TEST_ACP_SCENARIO: writeStubScenario(home, [{ steps: [{ say: "Done" }] }]),
    },
  });
  // First-time setup runs after the server listens; the jobs move once it has synced the worktrees.
  await waitFor(
    async () =>
      (await jobs()).every((j) => j.scope === "worktree" || !j.enabled) ? true : undefined,
    {
      label: "repo jobs migrated",
      timeoutMs: 30_000,
    },
  );
}, 120_000);

afterAll(async () => {
  await server?.close();
  removeTmpHome(home);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("upgrading an install with repo-scoped cronjobs", () => {
  it("S1: a repo job becomes a job of the default-branch worktree and keeps its chat", async () => {
    const job = (await jobs()).find((j) => j.id === "cj_old_app");
    expect(job).toMatchObject({
      name: "App nightly",
      prompt: "nightly prompt",
      cronExpression: "0 3 * * *",
      scope: "worktree",
      worktreeId: "app-main",
      fileKey: "app-main",
      via: "chat",
      enabled: true,
    });

    const fired = await trpc<{ chatId: string }>(server.url, "cronjobs.trigger", {
      key: "app-main",
      id: "cj_old_app",
    });
    expect(fired.chatId).toBe("chat_old_cron");
  });

  it("S1: keeps a disabled job disabled", async () => {
    const job = (await jobs()).find((j) => j.id === "cj_old_off");
    expect(job).toMatchObject({ worktreeId: "app-main", enabled: false });
  });

  it("S2: disables a job whose default branch is checked out nowhere, with the reason", async () => {
    const job = (await jobs()).find((j) => j.id === "cj_old_nomain");
    expect(job?.enabled).toBe(false);
    expect(job?.lastRunStatus).toBe("failed");
    expect(job?.lastRunMessage).toContain("not checked out on any host");
  });

  it("S2: disables a job of a repo that no longer exists, and deletes nothing", async () => {
    const all = await jobs();
    const job = all.find((j) => j.id === "cj_old_ghost");
    expect(job?.enabled).toBe(false);
    expect(job?.lastRunMessage).toContain("no longer exists");
    expect(all.map((j) => j.id).sort()).toEqual([
      "cj_old_app",
      "cj_old_ghost",
      "cj_old_nomain",
      "cj_old_off",
    ]);
  });
});
