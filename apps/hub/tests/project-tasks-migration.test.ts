// Integration test for upgrading to tasks (plan step T.2). The database is built the way a 6.3 install leaves it:
// every migration except the tasks one, real git worktrees, a task group of two repos with a PR number, and chats on
// two worktrees. The real hub then boots. Every worktree has become a task (a one-member task for a plain worktree, a
// task with two members for the group), the worktree folders are where they were, and the chats still open.

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

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const TASKS_MIGRATION = readdirSync(migrationsDir).find((n) => n.endsWith("_tasks")) as string;

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

const cloneOf = (name: string) => join(home, "repos", name);
const worktreeOf = (name: string, branch: string) => join(home, "worktrees", `${name}-${branch}`);

function seedRepo(name: string, branches: string[]): void {
  mkdirSync(cloneOf(name), { recursive: true });
  git(cloneOf(name), "init", "-q", "-b", "main");
  writeFileSync(join(cloneOf(name), "README.md"), `${name}\n`);
  git(cloneOf(name), "add", ".");
  git(cloneOf(name), "commit", "-q", "-m", "init");
  for (const branch of branches) {
    git(cloneOf(name), "worktree", "add", "-q", "-b", branch, worktreeOf(name, branch));
  }
}

const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

interface TaskView {
  id: string;
  name: string;
  branch: string;
  members: Array<{ repo: string; worktreeId: string | null; prNumber: number | null }>;
}

beforeAll(async () => {
  home = createTmpHome("band-tasks-migration-");
  seedSettings(home, { tokenSecret: TEST_TOKEN });
  seedRepo("api", ["feat-solo", "feat-both"]);
  seedRepo("web", ["feat-both", "loose"]);

  // An install from before this step.
  const before = join(home, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  rmSync(join(before, TASKS_MIGRATION), { recursive: true });
  const sqlite = new DatabaseSync(join(home, ".band", "band.db"));
  migrate(drizzle({ client: sqlite }), { migrationsFolder: before });
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO projects (id, name, description, context_name, coordinator_model, labels, policy, created_at)
       VALUES ('prj-shop', 'shop', '', 'shop', 'opus', '[]', '{}', ?)`,
    )
    .run(now);
  const insertRepo = sqlite.prepare(
    "INSERT INTO repos (name, path, default_branch, sort_order) VALUES (?, ?, 'main', ?)",
  );
  const insertWorktree = sqlite.prepare(
    "INSERT INTO worktrees (repo_name, name, branch, path, project_id) VALUES (?, ?, ?, ?, ?)",
  );
  const addRepoToProject = sqlite.prepare(
    "INSERT INTO project_repos (project_id, repo_name, role) VALUES ('prj-shop', ?, NULL)",
  );
  for (const [i, name] of ["api", "web"].entries()) {
    insertRepo.run(name, cloneOf(name), i);
    insertWorktree.run(name, "main", "main", cloneOf(name), null);
    addRepoToProject.run(name);
  }
  insertWorktree.run("api", "feat-solo", "feat-solo", worktreeOf("api", "feat-solo"), "prj-shop");
  insertWorktree.run("api", "feat-both", "feat-both", worktreeOf("api", "feat-both"), "prj-shop");
  insertWorktree.run("web", "feat-both", "feat-both", worktreeOf("web", "feat-both"), "prj-shop");
  // A worktree with no project at all.
  insertWorktree.run("web", "loose", "loose", worktreeOf("web", "loose"), null);

  // A 6.3 task group of two repos. The api member has its PR number.
  sqlite
    .prepare(
      `INSERT INTO task_groups (id, project_id, title, brief, branch, mode, created_at)
       VALUES ('tg-old1', 'prj-shop', 'Both repos', 'do it', 'feat-both', 'split', ?)`,
    )
    .run(now);
  const member = sqlite.prepare(
    `INSERT INTO task_group_members (group_id, repo, worktree_id, host_id, pr_number, merge_order)
     VALUES ('tg-old1', ?, ?, 'local', ?, ?)`,
  );
  member.run("api", "api-feat-both", 41, 0);
  member.run("web", "web-feat-both", null, 1);

  const chat = sqlite.prepare(
    `INSERT INTO panel_states (id, worktree_id, panel_type, state, labels, created_at, updated_at)
     VALUES (?, ?, 'chat', ?, NULL, ?, ?)`,
  );
  for (const [id, worktreeId] of [
    ["chat-solo", "api-feat-solo"],
    ["chat-loose", "web-loose"],
  ]) {
    chat.run(
      id,
      worktreeId,
      JSON.stringify({ name: "Chat", agent: "claude-code", activeSessionId: "s1", status: "idle" }),
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

describe("upgrading a database with worktrees and 6.3 task groups (S5)", () => {
  it("turns the task group into a task with its members, merge order and PR number", async () => {
    const { tasks } = await q<{ tasks: TaskView[] }>("projectTasks.list", { project: "shop" });
    const both = tasks.find((t) => t.id === "tg-old1");
    expect(both).toMatchObject({ name: "feat-both", branch: "feat-both" });
    expect(both?.members.map((x) => [x.repo, x.worktreeId, x.prNumber])).toEqual([
      ["api", "api-feat-both", 41],
      ["web", "web-feat-both", null],
    ]);
  });

  it("makes a one-member task of every other worktree, in its project or its repo's project", async () => {
    const { tasks } = await q<{ tasks: TaskView[] }>("projectTasks.list", { project: "shop" });
    const single = (id: string) =>
      tasks.filter((t) => t.members.length === 1 && t.members[0]?.worktreeId === id);
    for (const id of ["api-feat-solo", "api-main", "web-main", "web-loose"]) {
      expect(single(id), id).toHaveLength(1);
    }
    expect(single("api-feat-solo")[0]).toMatchObject({
      name: "api-feat-solo",
      branch: "feat-solo",
    });
  });

  it("leaves every worktree folder where it was and keeps the worktrees listed", async () => {
    for (const [name, branch] of [
      ["api", "feat-solo"],
      ["api", "feat-both"],
      ["web", "feat-both"],
      ["web", "loose"],
    ] as const) {
      expect(existsSync(join(worktreeOf(name, branch), ".git"))).toBe(true);
    }
    const { repos } = await q<{
      repos: Array<{ name: string; worktrees: Array<{ name: string; path: string }> }>;
    }>("repos.list");
    const names = repos.flatMap((r) => r.worktrees.map((w) => `${r.name}-${w.name}`));
    for (const id of ["api-feat-solo", "api-feat-both", "web-feat-both", "web-loose"]) {
      expect(names).toContain(id);
    }
    const solo = repos.find((r) => r.name === "api")?.worktrees.find((w) => w.name === "feat-solo");
    expect(solo?.path).toBe(worktreeOf("api", "feat-solo"));
  });

  it("keeps the chats on their worktrees and points them at the task", async () => {
    for (const [worktreeId, chatId] of [
      ["api-feat-solo", "chat-solo"],
      ["web-loose", "chat-loose"],
    ]) {
      const { chats } = await q<{ chats: Array<{ id: string }> }>("chats.list", { worktreeId });
      expect(chats.map((c) => c.id)).toEqual([chatId]);
    }
    const db = new DatabaseSync(join(home, ".band", "band.db"), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT worktree_id, task_id FROM panel_states WHERE id = 'chat-solo'")
        .get() as { worktree_id: string; task_id: string | null };
      expect(row.worktree_id).toBe("api-feat-solo");
      expect(row.task_id).toMatch(/^tsk-/);
      const loose = db
        .prepare("SELECT task_id FROM panel_states WHERE id = 'chat-loose'")
        .get() as { task_id: string | null };
      expect(loose.task_id).toMatch(/^tsk-/);
      // The task groups are gone.
      const gone = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('task_groups', 'task_group_members')",
        )
        .all();
      expect(gone).toEqual([]);
    } finally {
      db.close();
    }
  });
});
