import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "tasks-crud-test-token";
const MIGRATIONS_FOLDER = join(import.meta.dirname, "..", "src", "lib", "db", "migrations");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-tasks-crud-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
}

function seedSettings(tmpHome: string, settings: object): void {
  writeFileSync(join(tmpHome, ".band", "settings.json"), JSON.stringify(settings));
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
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

function openDb(tmpHome: string): InstanceType<typeof Database> {
  const dbPath = join(tmpHome, ".band", "band.db");
  mkdirSync(join(tmpHome, ".band"), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

function seedTask(
  tmpHome: string,
  task: {
    id: string;
    workspaceId: string;
    project: string;
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
      `INSERT OR REPLACE INTO tasks (id, workspace_id, project, branch, prompt, status, session_id, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.workspaceId,
      task.project,
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
      projects: [
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
      workspaceId: "alpha-main",
      project: "alpha",
      branch: "main",
      prompt: "alpha running task",
      status: "running",
      startedAt: now - 10_000,
    });

    seedTask(tmpHome, {
      id: "tsk_a2",
      workspaceId: "alpha-main",
      project: "alpha",
      branch: "main",
      prompt: "alpha completed task",
      status: "completed",
      startedAt: now - 20_000,
      completedAt: now - 15_000,
    });

    seedTask(tmpHome, {
      id: "tsk_a3",
      workspaceId: "alpha-main",
      project: "alpha",
      branch: "main",
      prompt: "alpha failed task",
      status: "failed",
      startedAt: now - 30_000,
      completedAt: now - 25_000,
    });

    seedTask(tmpHome, {
      id: "tsk_b1",
      workspaceId: "beta-main",
      project: "beta",
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns all tasks when no filter is provided", async () => {
    const res = await trpcQuery(server.url, "tasks.list", {});
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string }> }>(res);
    // tsk_a1 was running but gets cleaned up to failed on boot
    expect(data.tasks).toHaveLength(4);
  });

  it("filters by project", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { project: "alpha" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string; project: string }> }>(res);
    expect(data.tasks).toHaveLength(3);
    for (const task of data.tasks) {
      expect(task.project).toBe("alpha");
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

  it("filters by workspaceId", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { workspaceId: "beta-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string; workspaceId: string }> }>(res);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].workspaceId).toBe("beta-main");
  });

  it("filters by project and status combined", async () => {
    const res = await trpcQuery(server.url, "tasks.list", {
      project: "alpha",
      status: "completed",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: Array<{ id: string }> }>(res);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe("tsk_a2");
  });

  it("returns empty list for non-existent project", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { project: "nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tasks: unknown[] }>(res);
    expect(data.tasks).toEqual([]);
  });

  it("returns tasks with expected fields", async () => {
    const res = await trpcQuery(server.url, "tasks.list", { workspaceId: "beta-main" });
    const data = await trpcData<{
      tasks: Array<{
        id: string;
        workspaceId: string;
        project: string;
        branch: string;
        prompt: string;
        status: string;
        startedAt: number;
        completedAt: number | null;
      }>;
    }>(res);

    const task = data.tasks[0];
    expect(task.id).toBe("tsk_b1");
    expect(task.workspaceId).toBe("beta-main");
    expect(task.project).toBe("beta");
    expect(task.branch).toBe("main");
    expect(task.prompt).toBe("beta completed task");
    expect(task.status).toBe("completed");
    expect(typeof task.startedAt).toBe("number");
    expect(typeof task.completedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// tasks.get — returns currently running in-memory task for a workspace
// ---------------------------------------------------------------------------

describe("tRPC — tasks.get", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");

    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null when no task is running for a workspace", async () => {
    const res = await trpcQuery(server.url, "tasks.get", { workspaceId: "proj-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ task: null }>(res);
    expect(data.task).toBeNull();
  });

  it("returns null for a non-existent workspace", async () => {
    const res = await trpcQuery(server.url, "tasks.get", { workspaceId: "nonexistent-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ task: null }>(res);
    expect(data.task).toBeNull();
  });
});
