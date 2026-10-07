// Integration test for upgrading from the 6.2 coordinator layout (plan step T.1). The database is built the way a 6.2
// install leaves it: every migration except the project-folder one, a coordinator worktree per project (real git
// worktrees, one with its branch pushed) and the coordinator chat stored on that worktree. The real hub then boots and
// finishes the move: the chat belongs to the project and the coordinator worktrees are gone.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const FOLDER_MIGRATION = readdirSync(migrationsDir).find((n) =>
  n.endsWith("_project_folder"),
) as string;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" }).trim();

let home: string;
let server: ServerHandle;

const remoteOf = (name: string) => join(home, "remotes", `${name}.git`);
const cloneOf = (name: string) => join(home, "repos", name);
const worktreeOf = (name: string) => join(home, "worktrees", `${name}-coordinator`);

/** A repo with a bare origin and a coordinator worktree on `coordinator-<project>`, as 6.2 made it. */
function seedRepo(name: string, project: string, opts: { extraCommitOnRemote: boolean }): void {
  git(home, "init", "-q", "--bare", "-b", "main", remoteOf(name));
  git(home, "clone", "-q", remoteOf(name), cloneOf(name));
  git(cloneOf(name), "checkout", "-q", "-B", "main");
  writeFileSync(join(cloneOf(name), "README.md"), `${name}\n`);
  git(cloneOf(name), "add", ".");
  git(cloneOf(name), "commit", "-q", "-m", "init");
  git(cloneOf(name), "push", "-q", "-u", "origin", "main");
  const branch = `coordinator-${project}`;
  mkdirSync(join(home, "worktrees"), { recursive: true });
  git(cloneOf(name), "worktree", "add", "-q", "-b", branch, worktreeOf(name));
  if (opts.extraCommitOnRemote) {
    writeFileSync(join(worktreeOf(name), "work.md"), "someone's work\n");
    git(worktreeOf(name), "add", ".");
    git(worktreeOf(name), "commit", "-q", "-m", "work on the coordinator branch");
  }
  git(worktreeOf(name), "push", "-q", "origin", branch);
}

beforeAll(async () => {
  home = createTmpHome("band-folder-migration-");
  seedSettings(home, { tokenSecret: TEST_TOKEN });
  seedRepo("api", "shop", { extraCommitOnRemote: false });
  seedRepo("web", "ledger", { extraCommitOnRemote: true });

  // An install from before this step.
  const before = join(home, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  // Drizzle applies only migrations newer than the last one applied, so the install also lacks every later one.
  for (const name of readdirSync(migrationsDir)) {
    if (name >= FOLDER_MIGRATION) rmSync(join(before, name), { recursive: true });
  }
  const sqlite = new DatabaseSync(join(home, ".band", "band.db"));
  migrate(drizzle({ client: sqlite }), { migrationsFolder: before });
  const now = Date.now();
  for (const [i, [repo, project, id]] of [
    ["api", "shop", "prj-shop"],
    ["web", "ledger", "prj-ledger"],
  ].entries()) {
    sqlite
      .prepare(
        "INSERT INTO repos (name, path, default_branch, sort_order) VALUES (?, ?, 'main', ?)",
      )
      .run(repo, cloneOf(repo), i);
    sqlite
      .prepare(
        "INSERT INTO worktrees (repo_name, name, branch, path, project_id) VALUES (?, 'main', 'main', ?, NULL)",
      )
      .run(repo, cloneOf(repo));
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, description, context_name, coordinator_model, labels, policy,
           coordinator_worktree_id, coordinator_chat_id, created_at)
         VALUES (?, ?, '', ?, 'opus', '[]', '{}', ?, ?, ?)`,
      )
      .run(id, project, project, `${repo}-coordinator-${project}`, `chat-${project}`, now);
    sqlite
      .prepare(
        "INSERT INTO worktrees (repo_name, name, branch, path, project_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(repo, `coordinator-${project}`, `coordinator-${project}`, worktreeOf(repo), id);
    sqlite
      .prepare("INSERT INTO project_repos (project_id, repo_name, role) VALUES (?, ?, NULL)")
      .run(id, repo);
    sqlite
      .prepare(
        `INSERT INTO panel_states (id, worktree_id, panel_type, state, labels, created_at, updated_at)
         VALUES (?, ?, 'chat', ?, ?, ?, ?)`,
      )
      .run(
        `chat-${project}`,
        `${repo}-coordinator-${project}`,
        JSON.stringify({
          name: "Coordinator",
          agent: "claude-code",
          model: "opus",
          activeSessionId: "old-session",
          status: "idle",
        }),
        JSON.stringify({ "band:coordinator": id }),
        now,
        now,
      );
  }
  sqlite.close();

  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: { BAND_SERVE_UI: "false" },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  if (home) removeTmpHome(home);
});

const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

describe("upgrading a database with 6.2 coordinator worktrees (S5)", () => {
  it("moves the coordinator chat to its project, with no worktree", async () => {
    for (const [name, chatId] of [
      ["shop", "chat-shop"],
      ["ledger", "chat-ledger"],
    ]) {
      const { project } = await q<{ project: { coordinator: { chatId: string } | null } }>(
        "projects.get",
        { project: name },
      );
      expect(project.coordinator?.chatId).toBe(chatId);
      const { agents } = await q<{
        agents: Array<{ chatId: string; role: string; worktreeId: string | null }>;
      }>("projects.dashboard", { project: name });
      expect(agents.find((a) => a.chatId === chatId)).toMatchObject({
        role: "coordinator",
        worktreeId: null,
      });
    }
  });

  it("removes the coordinator worktrees and their local branches", async () => {
    await waitFor(
      () => (existsSync(worktreeOf("api")) || existsSync(worktreeOf("web")) ? undefined : true),
      {
        label: "coordinator worktrees removed",
        timeoutMs: 60_000,
      },
    );
    const { repos } = await q<{ repos: Array<{ worktrees: Array<{ name: string }> }> }>(
      "repos.list",
    );
    expect(repos.flatMap((r) => r.worktrees.map((w) => w.name))).not.toContain("coordinator-shop");
    expect(repos.flatMap((r) => r.worktrees.map((w) => w.name))).not.toContain(
      "coordinator-ledger",
    );
    expect(git(cloneOf("api"), "branch", "--list", "coordinator-shop")).toBe("");
    expect(git(cloneOf("web"), "branch", "--list", "coordinator-ledger")).toBe("");
    // The repos' own worktrees are untouched.
    expect(existsSync(join(cloneOf("api"), "README.md"))).toBe(true);
  });

  it("deletes a remote coordinator branch that holds no commits, and keeps one that does", async () => {
    await waitFor(
      () =>
        git(remoteOf("api"), "branch", "--list", "coordinator-shop") === "" ? true : undefined,
      { label: "empty remote branch deleted", timeoutMs: 60_000 },
    );
    expect(git(remoteOf("web"), "branch", "--list", "coordinator-ledger")).toContain(
      "coordinator-ledger",
    );
  });

  it("starts the moved chat on a fresh session, and leaves the list of leftovers empty", async () => {
    const db = new DatabaseSync(join(home, ".band", "band.db"), { readOnly: true });
    try {
      await waitFor(
        () =>
          (
            db.prepare("SELECT COUNT(*) AS n FROM legacy_coordinator_worktrees").get() as {
              n: number;
            }
          ).n === 0
            ? true
            : undefined,
        { label: "legacy list emptied", timeoutMs: 60_000 },
      );
      const row = db
        .prepare("SELECT project_id, worktree_id, state FROM panel_states WHERE id = 'chat-shop'")
        .get() as {
        project_id: string;
        worktree_id: string | null;
        state: string;
      };
      expect(row.project_id).toBe("prj-shop");
      expect(row.worktree_id).toBeNull();
      expect(JSON.parse(row.state).activeSessionId).toBeNull();
    } finally {
      db.close();
    }
  });
});
