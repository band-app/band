import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_CLAUDE_SCRIPT = join(import.meta.dirname, "fake-claude-loop.sh");
const DEFAULT_TOKEN = "loops-test-token";
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
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-loops-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  mkdirSync(join(bandDir, "status"), { recursive: true });
  return tmp;
}

function seedState(tmpHome: string, state: object): void {
  writeFileSync(join(tmpHome, ".band", "state.json"), JSON.stringify(state));
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

async function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
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

function seedLoop(
  tmpHome: string,
  loop: {
    id: string;
    workspaceId: string;
    project: string;
    branch: string;
    prompt: string;
    completionPromise: string;
    maxIterations: number;
    currentIteration: number;
    status: "running" | "paused" | "completed" | "failed" | "stopped";
    startedAt: number;
    completedAt?: number;
  },
): void {
  const sqlite = openDb(tmpHome);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO loops
       (id, workspace_id, project, branch, prompt, completion_promise, max_iterations,
        current_iteration, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      loop.id,
      loop.workspaceId,
      loop.project,
      loop.branch,
      loop.prompt,
      loop.completionPromise,
      loop.maxIterations,
      loop.currentIteration,
      loop.status,
      loop.startedAt,
      loop.completedAt ?? null,
    );
  sqlite.close();
}

function seedIteration(
  tmpHome: string,
  iter: {
    id: string;
    loopId: string;
    iteration: number;
    status: "running" | "completed" | "failed";
    output?: string;
    exitCode?: number;
    promiseDetected: boolean;
    startedAt: number;
    completedAt?: number;
  },
): void {
  const sqlite = openDb(tmpHome);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO loop_iterations
       (id, loop_id, iteration, status, output, exit_code, promise_detected, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      iter.id,
      iter.loopId,
      iter.iteration,
      iter.status,
      iter.output ?? null,
      iter.exitCode ?? null,
      iter.promiseDetected ? 1 : 0,
      iter.startedAt,
      iter.completedAt ?? null,
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
// Fake claude output setup
// ---------------------------------------------------------------------------

function setupFakeClaudeOutputDir(tmpHome: string): string {
  const dir = join(tmpHome, "fake-claude-output");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setIterationOutput(outputDir: string, iteration: number, content: string): void {
  writeFileSync(join(outputDir, `iteration-${iteration}.txt`), content);
}

function setDefaultOutput(outputDir: string, content: string): void {
  writeFileSync(join(outputDir, "default-output.txt"), content);
}

// ---------------------------------------------------------------------------
// Polling helper — waits for a condition with timeout
// ---------------------------------------------------------------------------

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (predicate(val)) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ===========================================================================
// loops.list — filtering
// ===========================================================================

describe("tRPC — loops.list filtering", () => {
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

    seedLoop(tmpHome, {
      id: "loop_a1",
      workspaceId: "alpha-main",
      project: "alpha",
      branch: "main",
      prompt: "alpha loop prompt",
      completionPromise: "DONE",
      maxIterations: 10,
      currentIteration: 5,
      status: "completed",
      startedAt: now - 10_000,
      completedAt: now - 5_000,
    });

    seedLoop(tmpHome, {
      id: "loop_a2",
      workspaceId: "alpha-main",
      project: "alpha",
      branch: "main",
      prompt: "alpha failed loop",
      completionPromise: "DONE",
      maxIterations: 25,
      currentIteration: 3,
      status: "failed",
      startedAt: now - 30_000,
      completedAt: now - 25_000,
    });

    seedLoop(tmpHome, {
      id: "loop_b1",
      workspaceId: "beta-main",
      project: "beta",
      branch: "main",
      prompt: "beta loop prompt",
      completionPromise: "ALL_TASKS_COMPLETE",
      maxIterations: 15,
      currentIteration: 15,
      status: "completed",
      startedAt: now - 50_000,
      completedAt: now - 40_000,
    });

    // Note: "running" loops get cleaned up to "failed" on server start,
    // so we don't seed a running loop here.

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns all loops when no filter is provided", async () => {
    const res = await trpcQuery(server.url, "loops.list", {});
    expect(res.status).toBe(200);
    const data = await trpcData<{ loops: Array<{ id: string }> }>(res);
    expect(data.loops).toHaveLength(3);
  });

  it("filters by workspaceId", async () => {
    const res = await trpcQuery(server.url, "loops.list", { workspaceId: "beta-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ loops: Array<{ id: string; workspaceId: string }> }>(res);
    expect(data.loops).toHaveLength(1);
    expect(data.loops[0].workspaceId).toBe("beta-main");
  });

  it("filters by status", async () => {
    const res = await trpcQuery(server.url, "loops.list", { status: "completed" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ loops: Array<{ id: string; status: string }> }>(res);
    expect(data.loops).toHaveLength(2);
    for (const loop of data.loops) {
      expect(loop.status).toBe("completed");
    }
  });

  it("filters by project", async () => {
    const res = await trpcQuery(server.url, "loops.list", { project: "alpha" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ loops: Array<{ id: string; project: string }> }>(res);
    expect(data.loops).toHaveLength(2);
    for (const loop of data.loops) {
      expect(loop.project).toBe("alpha");
    }
  });

  it("returns empty list for non-existent project", async () => {
    const res = await trpcQuery(server.url, "loops.list", { project: "nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ loops: unknown[] }>(res);
    expect(data.loops).toEqual([]);
  });

  it("returns loops with expected fields", async () => {
    const res = await trpcQuery(server.url, "loops.list", { workspaceId: "beta-main" });
    const data = await trpcData<{
      loops: Array<{
        id: string;
        workspaceId: string;
        project: string;
        branch: string;
        prompt: string;
        completionPromise: string;
        maxIterations: number;
        currentIteration: number;
        status: string;
        startedAt: number;
        completedAt: number | null;
      }>;
    }>(res);

    const loop = data.loops[0];
    expect(loop.id).toBe("loop_b1");
    expect(loop.workspaceId).toBe("beta-main");
    expect(loop.project).toBe("beta");
    expect(loop.branch).toBe("main");
    expect(loop.prompt).toBe("beta loop prompt");
    expect(loop.completionPromise).toBe("ALL_TASKS_COMPLETE");
    expect(loop.maxIterations).toBe(15);
    expect(loop.currentIteration).toBe(15);
    expect(loop.status).toBe("completed");
    expect(typeof loop.startedAt).toBe("number");
    expect(typeof loop.completedAt).toBe("number");
  });
});

// ===========================================================================
// loops.iterations — list iterations for a loop
// ===========================================================================

describe("tRPC — loops.iterations", () => {
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

    const now = Date.now();

    seedLoop(tmpHome, {
      id: "loop_iters",
      workspaceId: "proj-main",
      project: "proj",
      branch: "main",
      prompt: "test prompt",
      completionPromise: "DONE",
      maxIterations: 5,
      currentIteration: 3,
      status: "completed",
      startedAt: now - 60_000,
      completedAt: now - 30_000,
    });

    seedIteration(tmpHome, {
      id: "iter_1",
      loopId: "loop_iters",
      iteration: 1,
      status: "completed",
      output: "iteration 1 output",
      exitCode: 0,
      promiseDetected: false,
      startedAt: now - 60_000,
      completedAt: now - 50_000,
    });

    seedIteration(tmpHome, {
      id: "iter_2",
      loopId: "loop_iters",
      iteration: 2,
      status: "completed",
      output: "iteration 2 output",
      exitCode: 0,
      promiseDetected: false,
      startedAt: now - 50_000,
      completedAt: now - 40_000,
    });

    seedIteration(tmpHome, {
      id: "iter_3",
      loopId: "loop_iters",
      iteration: 3,
      status: "completed",
      output: "iteration 3 output DONE",
      exitCode: 0,
      promiseDetected: true,
      startedAt: now - 40_000,
      completedAt: now - 30_000,
    });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns iterations in order", async () => {
    const res = await trpcQuery(server.url, "loops.iterations", { loopId: "loop_iters" });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      iterations: Array<{
        id: string;
        loopId: string;
        iteration: number;
        status: string;
        output: string;
        exitCode: number;
        promiseDetected: boolean;
      }>;
    }>(res);

    expect(data.iterations).toHaveLength(3);
    expect(data.iterations[0].iteration).toBe(1);
    expect(data.iterations[1].iteration).toBe(2);
    expect(data.iterations[2].iteration).toBe(3);
  });

  it("iteration records have expected fields", async () => {
    const res = await trpcQuery(server.url, "loops.iterations", { loopId: "loop_iters" });
    const data = await trpcData<{
      iterations: Array<{
        id: string;
        loopId: string;
        iteration: number;
        status: string;
        output: string;
        exitCode: number;
        promiseDetected: boolean;
        startedAt: number;
        completedAt: number;
      }>;
    }>(res);

    const iter = data.iterations[2];
    expect(iter.id).toBe("iter_3");
    expect(iter.loopId).toBe("loop_iters");
    expect(iter.iteration).toBe(3);
    expect(iter.status).toBe("completed");
    expect(iter.output).toBe("iteration 3 output DONE");
    expect(iter.exitCode).toBe(0);
    expect(iter.promiseDetected).toBe(true);
    expect(typeof iter.startedAt).toBe("number");
    expect(typeof iter.completedAt).toBe("number");
  });

  it("returns empty list for unknown loopId", async () => {
    const res = await trpcQuery(server.url, "loops.iterations", { loopId: "nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ iterations: unknown[] }>(res);
    expect(data.iterations).toEqual([]);
  });
});

// ===========================================================================
// Stale loop cleanup on server start
// ===========================================================================

describe("tRPC — stale loop cleanup on startup", () => {
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

    const now = Date.now();

    // Seed a "running" loop — should be cleaned up to "failed" on startup
    seedLoop(tmpHome, {
      id: "loop_stale",
      workspaceId: "proj-main",
      project: "proj",
      branch: "main",
      prompt: "stale loop",
      completionPromise: "DONE",
      maxIterations: 10,
      currentIteration: 3,
      status: "running",
      startedAt: now - 300_000,
    });

    // Seed a "completed" loop — should NOT be affected
    seedLoop(tmpHome, {
      id: "loop_ok",
      workspaceId: "proj-main",
      project: "proj",
      branch: "main",
      prompt: "completed loop",
      completionPromise: "DONE",
      maxIterations: 5,
      currentIteration: 5,
      status: "completed",
      startedAt: now - 600_000,
      completedAt: now - 500_000,
    });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("marks stale running loops as failed on startup", async () => {
    const res = await trpcQuery(server.url, "loops.list", {});
    expect(res.status).toBe(200);
    const data = await trpcData<{ loops: Array<{ id: string; status: string }> }>(res);

    const staleLoop = data.loops.find((l) => l.id === "loop_stale");
    expect(staleLoop).toBeDefined();
    expect(staleLoop!.status).toBe("failed");
  });

  it("does not affect non-running loops on startup", async () => {
    const res = await trpcQuery(server.url, "loops.list", {});
    const data = await trpcData<{ loops: Array<{ id: string; status: string }> }>(res);

    const okLoop = data.loops.find((l) => l.id === "loop_ok");
    expect(okLoop).toBeDefined();
    expect(okLoop!.status).toBe("completed");
  });
});

// ===========================================================================
// loops.get — returns currently running in-memory loop for a workspace
// ===========================================================================

describe("tRPC — loops.get", () => {
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

  it("returns null when no loop is running for a workspace", async () => {
    const res = await trpcQuery(server.url, "loops.get", { workspaceId: "proj-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ loop: null }>(res);
    expect(data.loop).toBeNull();
  });

  it("returns null for a non-existent workspace", async () => {
    const res = await trpcQuery(server.url, "loops.get", { workspaceId: "nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ loop: null }>(res);
    expect(data.loop).toBeNull();
  });
});

// ===========================================================================
// loops.create — lifecycle with fake claude
// ===========================================================================

describe("tRPC — loops.create lifecycle", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let outputDir: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");
    outputDir = setupFakeClaudeOutputDir(tmpHome);

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
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: {
        type: "claude-code",
        command: FAKE_CLAUDE_SCRIPT,
      },
    });

    // Iteration 0: normal output (no promise)
    setIterationOutput(outputDir, 0, "Working on task 1...");
    // Iteration 1: normal output (no promise)
    setIterationOutput(outputDir, 1, "Working on task 2...");
    // Iteration 2: contains completion promise
    setIterationOutput(outputDir, 2, "All done! ALL_TASKS_COMPLETE");

    server = await startServer({
      tmpHome,
      env: { FAKE_CLAUDE_OUTPUT_DIR: outputDir },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates and runs a loop that stops on completion promise", async () => {
    const createRes = await trpcMutate(server.url, "loops.create", {
      workspaceId: "proj-main",
      prompt: "do the thing",
      completionPromise: "ALL_TASKS_COMPLETE",
      maxIterations: 10,
    });
    expect(createRes.status).toBe(200);

    const createData = await trpcData<{ id: string; workspaceId: string }>(createRes);
    expect(createData.workspaceId).toBe("proj-main");
    expect(createData.id).toBeTruthy();

    // Wait for the loop to complete (it should detect "ALL_TASKS_COMPLETE" in iteration 3)
    const loopData = await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "loops.list", { workspaceId: "proj-main" });
        return trpcData<{ loops: Array<{ id: string; status: string; currentIteration: number }> }>(
          res,
        );
      },
      (data) => {
        const loop = data.loops.find((l) => l.id === createData.id);
        return loop?.status === "completed" || loop?.status === "failed";
      },
      30_000,
    );

    const loop = loopData.loops.find((l) => l.id === createData.id)!;
    expect(loop.status).toBe("completed");
    expect(loop.currentIteration).toBe(3);

    // Verify iterations were recorded
    const itersRes = await trpcQuery(server.url, "loops.iterations", { loopId: createData.id });
    const itersData = await trpcData<{
      iterations: Array<{
        iteration: number;
        status: string;
        promiseDetected: boolean;
        output: string;
      }>;
    }>(itersRes);

    expect(itersData.iterations).toHaveLength(3);
    expect(itersData.iterations[0].promiseDetected).toBe(false);
    expect(itersData.iterations[1].promiseDetected).toBe(false);
    expect(itersData.iterations[2].promiseDetected).toBe(true);
    expect(itersData.iterations[2].output).toContain("ALL_TASKS_COMPLETE");
  });
});

// ===========================================================================
// loops.create — max iterations limit
// ===========================================================================

describe("tRPC — loops.create max iterations", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let outputDir: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");
    outputDir = setupFakeClaudeOutputDir(tmpHome);

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
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: {
        type: "claude-code",
        command: FAKE_CLAUDE_SCRIPT,
      },
    });

    // Default output never contains the promise
    setDefaultOutput(outputDir, "Still working...");

    server = await startServer({
      tmpHome,
      env: { FAKE_CLAUDE_OUTPUT_DIR: outputDir },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stops when max iterations is reached", async () => {
    const createRes = await trpcMutate(server.url, "loops.create", {
      workspaceId: "proj-main",
      prompt: "do the thing",
      completionPromise: "NEVER_FOUND",
      maxIterations: 3,
    });
    expect(createRes.status).toBe(200);
    const createData = await trpcData<{ id: string }>(createRes);

    // Wait for the loop to complete
    const loopData = await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "loops.list", { workspaceId: "proj-main" });
        return trpcData<{ loops: Array<{ id: string; status: string; currentIteration: number }> }>(
          res,
        );
      },
      (data) => {
        const loop = data.loops.find((l) => l.id === createData.id);
        return loop?.status !== "running";
      },
      30_000,
    );

    const loop = loopData.loops.find((l) => l.id === createData.id)!;
    expect(loop.status).toBe("completed");
    expect(loop.currentIteration).toBe(3);
  });
});

// ===========================================================================
// loops.create — validation errors
// ===========================================================================

describe("tRPC — loops.create validation", () => {
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

  it("rejects create for non-existent workspace", async () => {
    const res = await trpcMutate(server.url, "loops.create", {
      workspaceId: "nonexistent-main",
      prompt: "test",
      completionPromise: "DONE",
    });
    expect(res.status).toBe(404);
  });

  it("rejects create with empty prompt", async () => {
    const res = await trpcMutate(server.url, "loops.create", {
      workspaceId: "proj-main",
      prompt: "",
      completionPromise: "DONE",
    });
    expect(res.status).toBe(400);
  });

  it("rejects create with empty completionPromise", async () => {
    const res = await trpcMutate(server.url, "loops.create", {
      workspaceId: "proj-main",
      prompt: "test",
      completionPromise: "",
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// loops.pause / loops.resume / loops.stop — error cases
// ===========================================================================

describe("tRPC — loops pause/resume/stop error cases", () => {
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

  it("pause returns 404 when no loop is running", async () => {
    const res = await trpcMutate(server.url, "loops.pause", { workspaceId: "proj-main" });
    expect(res.status).toBe(404);
  });

  it("resume returns 404 when no loop is paused", async () => {
    const res = await trpcMutate(server.url, "loops.resume", { workspaceId: "proj-main" });
    expect(res.status).toBe(404);
  });

  it("stop returns 404 when no loop is active", async () => {
    const res = await trpcMutate(server.url, "loops.stop", { workspaceId: "proj-main" });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// loops.stop — stop a running loop
// ===========================================================================

describe("tRPC — loops.stop running loop", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let outputDir: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");
    outputDir = setupFakeClaudeOutputDir(tmpHome);

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
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: {
        type: "claude-code",
        command: FAKE_CLAUDE_SCRIPT,
      },
    });

    // Default output — never completes
    setDefaultOutput(outputDir, "Still working...");

    server = await startServer({
      tmpHome,
      env: {
        FAKE_CLAUDE_OUTPUT_DIR: outputDir,
        FAKE_CLAUDE_SLEEP: "5",
      },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stops a running loop", async () => {
    const createRes = await trpcMutate(server.url, "loops.create", {
      workspaceId: "proj-main",
      prompt: "long running loop",
      completionPromise: "NEVER",
      maxIterations: 100,
    });
    expect(createRes.status).toBe(200);
    const createData = await trpcData<{ id: string }>(createRes);

    // Wait for the loop to start (first iteration begins)
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "loops.get", { workspaceId: "proj-main" });
        return trpcData<{ loop: { status: string } | null }>(res);
      },
      (data) => data.loop?.status === "running",
      10_000,
    );

    // Stop it
    const stopRes = await trpcMutate(server.url, "loops.stop", { workspaceId: "proj-main" });
    expect(stopRes.status).toBe(200);

    // Wait for it to transition to stopped
    const loopData = await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "loops.list", { workspaceId: "proj-main" });
        return trpcData<{ loops: Array<{ id: string; status: string }> }>(res);
      },
      (data) => {
        const loop = data.loops.find((l) => l.id === createData.id);
        return loop?.status === "stopped" || loop?.status === "failed";
      },
      15_000,
    );

    const loop = loopData.loops.find((l) => l.id === createData.id)!;
    // The loop should be stopped or failed (depending on timing of SIGTERM)
    expect(["stopped", "failed"]).toContain(loop.status);
  });
});

// ===========================================================================
// loops.create — conflict detection
// ===========================================================================

describe("tRPC — loops conflict detection", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let outputDir: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");
    outputDir = setupFakeClaudeOutputDir(tmpHome);

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
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: {
        type: "claude-code",
        command: FAKE_CLAUDE_SCRIPT,
      },
    });

    // Use slow iterations so the loop stays running
    setDefaultOutput(outputDir, "still going...");

    server = await startServer({
      tmpHome,
      env: {
        FAKE_CLAUDE_OUTPUT_DIR: outputDir,
        FAKE_CLAUDE_SLEEP: "5",
      },
    });
  });

  afterAll(async () => {
    // Stop any running loops before closing
    await trpcMutate(server.url, "loops.stop", { workspaceId: "proj-main" }).catch(() => {});
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects creating a second loop on the same workspace", async () => {
    // Create first loop
    const createRes = await trpcMutate(server.url, "loops.create", {
      workspaceId: "proj-main",
      prompt: "first loop",
      completionPromise: "DONE",
      maxIterations: 100,
    });
    expect(createRes.status).toBe(200);

    // Wait for the loop to be running
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "loops.get", { workspaceId: "proj-main" });
        return trpcData<{ loop: { status: string } | null }>(res);
      },
      (data) => data.loop?.status === "running",
      10_000,
    );

    // Try to create second loop — should conflict
    const secondRes = await trpcMutate(server.url, "loops.create", {
      workspaceId: "proj-main",
      prompt: "second loop",
      completionPromise: "DONE",
      maxIterations: 5,
    });
    expect(secondRes.status).toBe(409);
  });
});
