// V6 of the projects redesign: an install from before the redesign boots. The database is built the
// way an older hub leaves it: every migration applied, a default project `personal` (is_default) with
// a repo, a worktree that has a project and a one-member task, a worktree chat with a task id and a
// chat of a multi-repo task folder (a task id and no worktree), plus a normal project "shop" whose
// multi-repo task has two member worktrees. Real git worktrees, a real bare context repo for
// `personal`. Then the real hub boots, and every assertion goes through it (and the database file
// only for the task links that have no API projection).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STUB_AGENT_PATH, TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");

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
const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

interface ProjectView {
  id: string;
  name: string;
  repos: Array<{ repo: string }>;
  worktrees: Array<{ worktreeId: string }>;
}
interface ReposList {
  repos: Array<{ name: string; worktrees: Array<{ name: string; projectId?: string }> }>;
}

const worktreeProject = async (repo: string, name: string) =>
  (await q<ReposList>("repos.list")).repos
    .find((r) => r.name === repo)
    ?.worktrees.find((w) => w.name === name);

beforeAll(async () => {
  home = createTmpHome("band-legacy-retire-");
  seedSettings(home, { tokenSecret: TEST_TOKEN });
  seedRepo("notes", ["feat-p"]);
  seedRepo("api", ["feat-both"]);
  seedRepo("web", ["feat-both"]);
  // The default project's context repo, which the boot must keep.
  mkdirSync(join(home, ".band", "context"), { recursive: true });
  git(home, "init", "-q", "--bare", "-b", "main", join(home, ".band", "context", "personal.git"));

  const sqlite = new DatabaseSync(join(home, ".band", "band.db"));
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsDir });
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO contexts (id, name, kind, labels, repos, created_at)
       VALUES ('ctx-personal', 'personal', 'project', '[]', '[]', ?)`,
    )
    .run(now);
  const insertProject = sqlite.prepare(
    `INSERT INTO projects (id, name, description, context_name, is_default, coordinator_model, labels, policy, created_at)
     VALUES (?, ?, '', ?, ?, 'opus', '[]', '{}', ?)`,
  );
  insertProject.run("prj-personal", "personal", "personal", 1, now);
  insertProject.run("prj-shop", "shop", "shop", 0, now + 1);
  const insertRepo = sqlite.prepare(
    "INSERT INTO repos (name, path, default_branch, sort_order) VALUES (?, ?, 'main', ?)",
  );
  const insertWorktree = sqlite.prepare(
    "INSERT INTO worktrees (repo_name, name, branch, path, project_id, task_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const addRepoToProject = sqlite.prepare(
    "INSERT INTO project_repos (project_id, repo_name, role) VALUES (?, ?, NULL)",
  );
  for (const [i, name] of ["notes", "api", "web"].entries()) {
    insertRepo.run(name, cloneOf(name), i);
    insertWorktree.run(name, "main", "main", cloneOf(name), null, null);
  }
  addRepoToProject.run("prj-personal", "notes");
  addRepoToProject.run("prj-shop", "api");
  addRepoToProject.run("prj-shop", "web");
  insertWorktree.run(
    "notes",
    "feat-p",
    "feat-p",
    worktreeOf("notes", "feat-p"),
    "prj-personal",
    "tsk-p",
  );
  insertWorktree.run(
    "api",
    "feat-both",
    "feat-both",
    worktreeOf("api", "feat-both"),
    "prj-shop",
    "tsk-both",
  );
  insertWorktree.run(
    "web",
    "feat-both",
    "feat-both",
    worktreeOf("web", "feat-both"),
    "prj-shop",
    "tsk-both",
  );

  const insertTask = sqlite.prepare(
    `INSERT INTO project_tasks (id, project_id, name, branch, brief_path, host_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'local', 'active', ?)`,
  );
  insertTask.run("tsk-p", "prj-personal", "notes-feat-p", "feat-p", null, now);
  insertTask.run(
    "tsk-both",
    "prj-shop",
    "feat-both",
    "feat-both",
    join(home, ".band", "projects", "shop", "tasks", "feat-both", "BRIEF.md"),
    now,
  );
  const insertMember = sqlite.prepare(
    `INSERT INTO task_members (task_id, repo_name, worktree_id, role, merge_order, pr_number)
     VALUES (?, ?, ?, NULL, ?, NULL)`,
  );
  insertMember.run("tsk-p", "notes", "notes-feat-p", 0);
  insertMember.run("tsk-both", "api", "api-feat-both", 0);
  insertMember.run("tsk-both", "web", "web-feat-both", 1);

  const chat = sqlite.prepare(
    `INSERT INTO panel_states (id, worktree_id, project_id, task_id, panel_type, state, labels, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'chat', ?, NULL, ?, ?)`,
  );
  const state = JSON.stringify({
    name: "Chat",
    agent: "claude-code",
    activeSessionId: "s1",
    status: "idle",
  });
  // A worktree chat of a one-member task.
  chat.run("chat-worktree", "notes-feat-p", null, "tsk-p", state, now, now);
  // The chat of the multi-repo task folder: a task id and no worktree.
  chat.run("chat-task", null, "prj-shop", "tsk-both", state, now, now);
  sqlite.close();

  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
    },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  if (home) removeTmpHome(home);
});

describe("booting an install with a default project and task folders (V6)", () => {
  it("removes the default project and keeps the normal one", async () => {
    const { projects } = await q<{ projects: ProjectView[] }>("projects.list");
    expect(projects.map((p) => p.name)).toEqual(["shop"]);
    const missing = await trpcQuery(
      server.url,
      "projects.get",
      { project: "personal" },
      TEST_TOKEN,
    );
    expect(missing.status).toBe(404);
    expect((await trpcQuery(server.url, "projects.list", undefined, "")).status).toBe(401);
  });

  it("keeps the default project's repo and worktree, in no project", async () => {
    const { repos } = await q<ReposList>("repos.list");
    expect(repos.map((r) => r.name).sort()).toEqual(["api", "notes", "web"]);
    const worktree = await worktreeProject("notes", "feat-p");
    expect(worktree).toBeDefined();
    expect(worktree?.projectId).toBeUndefined();
    expect(existsSync(join(worktreeOf("notes", "feat-p"), ".git"))).toBe(true);
  });

  it("keeps the default project's context repo", async () => {
    const { contexts } = await q<{ contexts: Array<{ name: string }> }>("context.list");
    expect(contexts.map((c) => c.name)).toContain("personal");
    expect(existsSync(join(home, ".band", "context", "personal.git"))).toBe(true);
  });

  it("keeps the worktree chat on its worktree and hides the task folder's chat", async () => {
    const onWorktree = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: "notes-feat-p",
    });
    expect(onWorktree.chats.map((c) => c.id)).toEqual(["chat-worktree"]);
    const onProject = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: "project:prj-shop",
    });
    expect(onProject.chats.map((c) => c.id)).not.toContain("chat-task");
    for (const worktreeId of ["api-feat-both", "web-feat-both"]) {
      const { chats } = await q<{ chats: Array<{ id: string }> }>("chats.list", { worktreeId });
      expect(chats.map((c) => c.id)).not.toContain("chat-task");
    }
  });

  it("keeps the task members as worktrees of their project", async () => {
    const shop = (await q<{ project: ProjectView }>("projects.get", { project: "shop" })).project;
    expect(shop.repos.map((r) => r.repo)).toEqual(["api", "web"]);
    expect(shop.worktrees.map((w) => w.worktreeId).sort()).toEqual([
      "api-feat-both",
      "web-feat-both",
    ]);
    expect((await worktreeProject("api", "feat-both"))?.projectId).toBe("prj-shop");
    expect((await worktreeProject("web", "feat-both"))?.projectId).toBe("prj-shop");
  });

  it("clears the task links of worktrees and of worktree chats", () => {
    const db = new DatabaseSync(join(home, ".band", "band.db"), { readOnly: true });
    try {
      const linked = db
        .prepare("SELECT repo_name, name FROM worktrees WHERE task_id IS NOT NULL")
        .all();
      expect(linked).toEqual([]);
      const chat = db
        .prepare("SELECT worktree_id, task_id FROM panel_states WHERE id = 'chat-worktree'")
        .get() as { worktree_id: string; task_id: string | null };
      expect(chat).toEqual({ worktree_id: "notes-feat-p", task_id: null });
      const gone = db.prepare("SELECT id FROM projects WHERE is_default = 1").all();
      expect(gone).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("creates a project afterwards, and a worktree with no project joins none", async () => {
    const { project } = await m<{ project: ProjectView }>("projects.create", {
      name: "fresh",
      repos: [{ repo: "notes" }],
    });
    expect(project.repos.map((r) => r.repo)).toEqual(["notes"]);
    await m("worktrees.create", { repo: "notes", branch: "after-upgrade" });
    expect((await worktreeProject("notes", "after-upgrade"))?.projectId).toBeUndefined();
    const { projects } = await q<{ projects: ProjectView[] }>("projects.list");
    expect(projects.map((p) => p.name)).toEqual(["shop", "fresh"]);
  });
});
