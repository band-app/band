// An install from before the Projects feature was removed. The DB is migrated up to the step
// before `remove_projects`, seeded with a project, its context, a project task, a worktree and
// chat that belong to the project, a coordinator chat and subscription, then migrated forward and
// booted by a real hub. Everything lives in temp dirs, never in ~/.band.

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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "projects-removal-secret";
const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const NEW_MIGRATION = readdirSync(migrationsDir).find((n) => n.endsWith("_remove_projects")) ?? "";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

const CHAT_STATE = JSON.stringify({ name: "Chat", agent: "claude-code", status: "idle" });

let server: ServerHandle;
let repoPath: string;
let worktreePath: string;
let tablesAfter: string[] = [];
let leftovers: Record<string, number | string[]> = {};

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

beforeAll(async () => {
  expect(NEW_MIGRATION).not.toBe("");
  const hubHome = createTmpHome("band-projects-removal-");
  scratch.push(hubHome);
  const checkouts = tmp("band-projects-removal-repos-");
  repoPath = join(checkouts, "app");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, "init", "-q", "-b", "main");
  writeFileSync(join(repoPath, "a.txt"), "a\n");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-q", "-m", "init");
  worktreePath = join(checkouts, "app-feat");
  git(repoPath, "worktree", "add", "-q", "-b", "feat", worktreePath);
  const plainPath = join(checkouts, "app-plain");
  git(repoPath, "worktree", "add", "-q", "-b", "plain", plainPath);

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
      "INSERT INTO repos (name, path, default_branch, sort_order) VALUES ('app', ?, 'main', 0)",
    )
    .run(repoPath);
  sqlite.exec(`
    INSERT INTO contexts (id, name, kind, created_at) VALUES ('ctx-1', 'checkout', 'project', 1);
    INSERT INTO context_events (id, context, host_id, kind, detail, at) VALUES ('ev-1', 'checkout', 'local', 'conflict', '', 1);
    INSERT INTO projects (id, name, context_name, coordinator_chat_id, created_at)
      VALUES ('prj-1', 'checkout', 'checkout', 'chat-coordinator', 1);
    INSERT INTO project_repos (project_id, repo_name) VALUES ('prj-1', 'app');
    INSERT INTO project_tasks (id, project_id, name, branch, created_at)
      VALUES ('task-1', 'prj-1', 'feat-x', 'feat/x', 1);
    INSERT INTO task_members (task_id, repo_name, worktree_id) VALUES ('task-1', 'app', 'app-feat');
    INSERT INTO worktrees (repo_name, name, branch, path, project_id, task_id)
      VALUES ('app', 'main', 'main', '${repoPath}', NULL, NULL);
    INSERT INTO worktrees (repo_name, name, branch, path, project_id, task_id)
      VALUES ('app', 'feat', 'feat', '${worktreePath}', 'prj-1', 'task-1');
    INSERT INTO worktrees (repo_name, name, branch, path, project_id, task_id)
      VALUES ('app', 'plain', 'plain', '${plainPath}', NULL, NULL);
    INSERT INTO panel_states (id, worktree_id, project_id, panel_type, state, created_at, updated_at)
      VALUES ('chat-plain', 'app-plain', NULL, 'chat', '${CHAT_STATE}', 1, 1);
    INSERT INTO panel_states (id, worktree_id, project_id, panel_type, state, created_at, updated_at)
      VALUES ('chat-member', 'app-feat', NULL, 'chat', '${CHAT_STATE}', 1, 1);
    INSERT INTO panel_states (id, worktree_id, project_id, panel_type, state, created_at, updated_at)
      VALUES ('chat-coordinator', NULL, 'prj-1', 'chat', '${CHAT_STATE}', 1, 1);
    INSERT INTO subscriptions
      (id, chat_id, worktree_id, source, kinds, filter_key, coalesce_seconds, max_wakeups, wakeups, expires_at, created_by, created_at)
      VALUES ('sub-coord', 'chat-coordinator', 'project:prj-1', 'project', '[]', 'project:prj-1', 30, 1000, 0, 9999999999999, 'coordinator', 1);
    INSERT INTO subscriptions
      (id, chat_id, worktree_id, source, kinds, filter_key, coalesce_seconds, max_wakeups, wakeups, expires_at, created_by, created_at)
      VALUES ('sub-agent', 'chat-plain', 'app-plain', 'timer', '[]', 'timer:1', 0, 1, 0, 9999999999999, 'agent', 1);
    INSERT INTO chat_events (chat_id, session_id, revision, kind, payload, created_at)
      VALUES ('chat-coordinator', 's1', 1, 'update', '{}', 1);
    INSERT INTO chat_events (chat_id, session_id, revision, kind, payload, created_at)
      VALUES ('chat-plain', 's2', 1, 'update', '{}', 1);
    INSERT INTO subscription_events (event_id, subscription_id, received_at, summary)
      VALUES ('ev-coord', 'sub-coord', 1, 'x');
    INSERT INTO client_state (key, scope, worktree_id, value, version, updated_at)
      VALUES ('band-draft:project:prj-1', 'all', 'project:prj-1', '"plan"', 1, 1);
  `);

  // The migration under test.
  migrate(db, { migrationsFolder: migrationsDir });
  tablesAfter = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
  leftovers = {
    coordinatorChats: count("SELECT count(*) AS n FROM panel_states WHERE id = 'chat-coordinator'"),
    coordinatorSubs: count("SELECT count(*) AS n FROM subscriptions WHERE id = 'sub-coord'"),
    agentSubs: count("SELECT count(*) AS n FROM subscriptions WHERE id = 'sub-agent'"),
    projectState: count(
      "SELECT count(*) AS n FROM client_state WHERE worktree_id LIKE 'project:%'",
    ),
    worktrees: count("SELECT count(*) AS n FROM worktrees"),
    coordinatorChatEvents: count(
      "SELECT count(*) AS n FROM chat_events WHERE chat_id = 'chat-coordinator'",
    ),
    plainChatEvents: count("SELECT count(*) AS n FROM chat_events WHERE chat_id = 'chat-plain'"),
    coordinatorSubEvents: count(
      "SELECT count(*) AS n FROM subscription_events WHERE subscription_id = 'sub-coord'",
    ),
    projectColumns: [
      ...(sqlite.prepare("PRAGMA table_info(worktrees)").all() as Array<{ name: string }>),
      ...(sqlite.prepare("PRAGMA table_info(panel_states)").all() as Array<{ name: string }>),
    ]
      .map((c) => c.name)
      .filter((n) => n === "project_id" || n === "task_id"),
  };
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
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("upgrading an install that had projects", () => {
  it("drops the project, context and project task tables", () => {
    for (const table of [
      "projects",
      "project_repos",
      "project_tasks",
      "task_members",
      "contexts",
      "context_events",
      "dispatch_requests",
      "retro_proposals",
      "legacy_coordinator_worktrees",
    ]) {
      expect(tablesAfter, table).not.toContain(table);
    }
  });

  it("removes the coordinator's chat and subscriptions and the project views' UI state", () => {
    expect(leftovers.coordinatorChats).toBe(0);
    expect(leftovers.coordinatorSubs).toBe(0);
    expect(leftovers.projectState).toBe(0);
    expect(leftovers.coordinatorChatEvents).toBe(0);
    expect(leftovers.coordinatorSubEvents).toBe(0);
    expect(leftovers.plainChatEvents).toBe(1);
    expect(leftovers.projectColumns).toEqual([]);
  });

  it("keeps the generic subscriptions and every worktree", () => {
    expect(leftovers.agentSubs).toBe(1);
    expect(leftovers.worktrees).toBe(3);
  });

  it("starts, lists the repo and its worktrees, and opens the chats of plain worktrees", async () => {
    const { repos } = await q<{
      repos: Array<{ name: string; worktrees: Array<{ name: string }> }>;
    }>("repos.list");
    expect(repos.map((r) => r.name)).toEqual(["app"]);
    expect(repos[0]?.worktrees.map((w) => w.name).sort()).toEqual(["feat", "main", "plain"]);
    const plain = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: "app-plain",
    });
    expect(plain.chats.map((c) => c.id)).toEqual(["chat-plain"]);
    const member = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: "app-feat",
    });
    expect(member.chats.map((c) => c.id)).toEqual(["chat-member"]);
  });

  it("no longer serves the projects or context routers", async () => {
    for (const procedure of ["projects.list", "context.list"]) {
      const res = await trpcQuery(server.url, procedure, undefined, TOKEN);
      expect(res.status, procedure).toBe(404);
    }
  });
});
