import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome as createCanonicalTmpHome,
  type ServerHandle,
  startServer as startCanonicalServer,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";

const DEFAULT_TOKEN = "tasks-crud-test-token";
const MIGRATIONS_FOLDER = join(
  import.meta.dirname,
  "..",
  "src",
  "server",
  "infra",
  "db",
  "migrations",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpHome(): string {
  return createCanonicalTmpHome("band-tasks-crud-test-");
}

function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  return startCanonicalServer({ tmpHome: opts.tmpHome || createTmpHome(), env: opts.env });
}

// ---------------------------------------------------------------------------
// tRPC HTTP helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// DB seeding helpers
// ---------------------------------------------------------------------------

function openDb(tmpHome: string): DatabaseSync {
  const dbPath = join(tmpHome, ".band", "band.db");
  mkdirSync(join(tmpHome, ".band"), { recursive: true });
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

function seedTask(
  tmpHome: string,
  task: {
    id: string;
    worktreeId: string;
    repo: string;
    branch: string;
    prompt: string;
    status: "running" | "completed" | "failed";
    sessionId?: string;
    startedAt: number;
    completedAt?: number;
  },
): void {
  const sqlite = openDb(tmpHome);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, worktree_id, repo, branch, prompt, status, session_id, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.worktreeId,
      task.repo,
      task.branch,
      task.prompt,
      task.status,
      task.sessionId ?? null,
      task.startedAt,
      task.completedAt ?? null,
    );
  sqlite.close();
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# Test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// tasks.list — filtering
// ---------------------------------------------------------------------------

describe("tRPC — tasks.list filtering", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo1 = createGitRepo(tmpHome, "alpha");
    const repo2 = createGitRepo(tmpHome, "beta");

    seedState(tmpHome, {
      repos: [
        {
          name: "alpha",
          path: repo1,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo1 }],
        },
        {
          name: "beta",
          path: repo2,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo2 }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const now = Date.now();

    seedTask(tmpHome, {
      id: "tsk_a1",
      worktreeId: "alpha-main",
      repo: "alpha",
      branch: "main",
      prompt: "alpha running task",
      status: "running",
      startedAt: now - 10_000,
    });

    seedTask(tmpHome, {
      id: "tsk_a2",
      worktreeId: "alpha-main",
      repo: "alpha",
      branch: "main",
      prompt: "alpha completed task",
      status: "completed",
      startedAt: now - 20_000,
      completedAt: now - 15_000,
    });

    seedTask(tmpHome, {
      id: "tsk_a3",
      worktreeId: "alpha-main",
      repo: "alpha",
      branch: "main",
      prompt: "alpha failed task",
      status: "failed",
      startedAt: now - 30_000,
      completedAt: now - 25_000,
    });

    seedTask(tmpHome, {
      id: "tsk_b1",
      worktreeId: "beta-main",
      repo: "beta",
      branch: "main",
      prompt: "beta completed task",
      status: "completed",
      startedAt: now - 40_000,
      completedAt: now - 35_000,
    });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("returns all tasks when no filter is provided", async () => {
    const res = await trpcQuery(server.url, "tasks.list", {});
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string }> }>(res);
    // tsk_a1 was running but gets cleaned up to failed on boot
    expect(data.tasks).toHaveLength(4);
  });

  it("filters by repo", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { repo: "alpha" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string; repo: string }> }>(res);
    expect(data.tasks).toHaveLength(3);
    for (const task of data.tasks) {
      expect(task.repo).toBe("alpha");
    }
  });

  it("filters by status", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { status: "completed" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string; status: string }> }>(res);
    expect(data.tasks).toHaveLength(2);
    for (const task of data.tasks) {
      expect(task.status).toBe("completed");
    }
  });

  it("filters by worktreeId", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { worktreeId: "beta-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string; worktreeId: string }> }>(res);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].worktreeId).toBe("beta-main");
  });

  it("filters by repo and status combined", async () => {
    const res = await trpcQuery(server.url, "tasks.list", {
      repo: "alpha",
      status: "completed",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string }> }>(res);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe("tsk_a2");
  });

  it("returns empty list for non-existent repo", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { repo: "nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: unknown[] }>(res);
    expect(data.tasks).toEqual([]);
  });

  it("returns tasks with expected fields", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { worktreeId: "beta-main" });
    const data = await trpcData<{
      tasks: Array<{
        id: string;
        worktreeId: string;
        repo: string;
        branch: string;
        prompt: string;
        status: string;
        startedAt: number;
        completedAt: number | null;
      }>;
    }>(res);

    const task = data.tasks[0];
    expect(task.id).toBe("tsk_b1");
    expect(task.worktreeId).toBe("beta-main");
    expect(task.repo).toBe("beta");
    expect(task.branch).toBe("main");
    expect(task.prompt).toBe("beta completed task");
    expect(task.status).toBe("completed");
    expect(typeof task.startedAt).toBe("number");
    expect(typeof task.completedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// tasks.get — returns currently running in-memory task for a worktree
// ---------------------------------------------------------------------------

describe("tRPC — tasks.get", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");

    seedState(tmpHome, {
      repos: [
        {
          name: "proj",
          path: repo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("returns null when no task is running for a worktree", async () => {
    const res = await trpcQuery(server.url, "tasks.get", { worktreeId: "proj-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ task: null }>(res);
    expect(data.task).toBeNull();
  });

  it("returns null for a non-existent worktree", async () => {
    const res = await trpcQuery(server.url, "tasks.get", { worktreeId: "nonexistent-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ task: null }>(res);
    expect(data.task).toBeNull();
  });
});
