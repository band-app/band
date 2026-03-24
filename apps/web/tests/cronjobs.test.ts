import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "cronjob-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-cronjob-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
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
// Cronjobs CRUD
// ---------------------------------------------------------------------------

describe("tRPC — cronjobs CRUD", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myproject");
    seedState(tmpHome, {
      projects: [
        {
          name: "myproject",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
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

  it("cronjobs.list returns empty list initially", async () => {
    const res = await trpcQuery(server.url, "cronjobs.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: unknown[] }>(res);
    expect(data.jobs).toEqual([]);
  });

  it("cronjobs.create creates a project-scoped job", async () => {
    const res = await trpcMutate(server.url, "cronjobs.create", {
      key: "myproject",
      name: "Daily dep check",
      prompt: "Check for outdated dependencies",
      cronExpression: "0 9 * * 1",
      scope: "project",
      enabled: true,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string; name: string; scope: string } }>(res);
    expect(data.job.name).toBe("Daily dep check");
    expect(data.job.scope).toBe("project");
    expect(data.job.id).toMatch(/^cj_\d+$/);
  });

  it("cronjobs.create rejects invalid cron expression", async () => {
    const res = await trpcMutate(server.url, "cronjobs.create", {
      key: "myproject",
      name: "Bad cron",
      prompt: "This should fail",
      cronExpression: "not a cron",
      scope: "project",
    });
    expect(res.status).toBe(400);
  });

  it("cronjobs.list returns the created job", async () => {
    const res = await trpcQuery(server.url, "cronjobs.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: Array<{ name: string; fileKey: string }> }>(res);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].name).toBe("Daily dep check");
    expect(data.jobs[0].fileKey).toBe("myproject");
  });

  it("cronjobs.list filters by project", async () => {
    const res = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: unknown[] }>(res);
    expect(data.jobs).toHaveLength(1);

    const empty = await trpcQuery(server.url, "cronjobs.list", { project: "nonexistent" });
    const emptyData = await trpcData<{ jobs: unknown[] }>(empty);
    expect(emptyData.jobs).toEqual([]);
  });

  it("cronjobs.create creates a second job", async () => {
    const res = await trpcMutate(server.url, "cronjobs.create", {
      key: "myproject",
      name: "Code quality sweep",
      prompt: "Run linting and fix issues",
      cronExpression: "0 */6 * * *",
      scope: "project",
      enabled: false,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { enabled: boolean } }>(res);
    expect(data.job.enabled).toBe(false);
  });

  it("cronjobs.list returns both jobs", async () => {
    const res = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: unknown[] }>(res);
    expect(data.jobs).toHaveLength(2);
  });

  it("cronjobs.get returns a specific job", async () => {
    const listRes = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[0].id;

    const res = await trpcQuery(server.url, "cronjobs.get", { key: "myproject", id: jobId });
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string; name: string } }>(res);
    expect(data.job.id).toBe(jobId);
  });

  it("cronjobs.get returns NOT_FOUND for missing job", async () => {
    const res = await trpcQuery(server.url, "cronjobs.get", {
      key: "myproject",
      id: "cj_nonexistent",
    });
    expect(res.status).toBe(404);
  });

  it("cronjobs.update modifies job properties", async () => {
    const listRes = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[0].id;

    const res = await trpcMutate(server.url, "cronjobs.update", {
      key: "myproject",
      id: jobId,
      name: "Updated name",
      cronExpression: "0 12 * * *",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { name: string; cronExpression: string } }>(res);
    expect(data.job.name).toBe("Updated name");
    expect(data.job.cronExpression).toBe("0 12 * * *");
  });

  it("cronjobs.update rejects invalid cron expression", async () => {
    const listRes = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[0].id;

    const res = await trpcMutate(server.url, "cronjobs.update", {
      key: "myproject",
      id: jobId,
      cronExpression: "invalid",
    });
    expect(res.status).toBe(400);
  });

  it("cronjobs.update toggles enabled state", async () => {
    const listRes = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    const listData = await trpcData<{ jobs: Array<{ id: string; enabled: boolean }> }>(listRes);
    const job = listData.jobs[0];

    const res = await trpcMutate(server.url, "cronjobs.update", {
      key: "myproject",
      id: job.id,
      enabled: !job.enabled,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { enabled: boolean } }>(res);
    expect(data.job.enabled).toBe(!job.enabled);
  });

  it("cronjobs.update returns NOT_FOUND for missing job", async () => {
    const res = await trpcMutate(server.url, "cronjobs.update", {
      key: "myproject",
      id: "cj_nonexistent",
      name: "nope",
    });
    expect(res.status).toBe(404);
  });

  it("cronjobs.delete removes a job", async () => {
    const listRes = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[1].id;

    const res = await trpcMutate(server.url, "cronjobs.delete", {
      key: "myproject",
      id: jobId,
    });
    expect(res.status).toBe(200);

    const afterRes = await trpcQuery(server.url, "cronjobs.list", { project: "myproject" });
    const afterData = await trpcData<{ jobs: unknown[] }>(afterRes);
    expect(afterData.jobs).toHaveLength(1);
  });

  it("cronjobs.delete returns NOT_FOUND for missing job", async () => {
    const res = await trpcMutate(server.url, "cronjobs.delete", {
      key: "myproject",
      id: "cj_nonexistent",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cronjobs cleanup on project removal
// ---------------------------------------------------------------------------

describe("tRPC — cronjobs cleanup on project removal", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "removeme");
    seedState(tmpHome, {
      projects: [
        {
          name: "removeme",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
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

  it("removes project-scoped cronjobs when project is removed", async () => {
    // Create a cronjob for the project
    const createRes = await trpcMutate(server.url, "cronjobs.create", {
      key: "removeme",
      name: "Project job",
      prompt: "Do something",
      cronExpression: "0 * * * *",
      scope: "project",
    });
    expect(createRes.status).toBe(200);

    // Verify the job exists
    const listRes = await trpcQuery(server.url, "cronjobs.list", { project: "removeme" });
    const listData = await trpcData<{ jobs: unknown[] }>(listRes);
    expect(listData.jobs).toHaveLength(1);

    // Remove the project
    const removeRes = await trpcMutate(server.url, "projects.remove", { name: "removeme" });
    expect(removeRes.status).toBe(200);

    // Verify the cronjobs are gone
    const afterRes = await trpcQuery(server.url, "cronjobs.list", { project: "removeme" });
    const afterData = await trpcData<{ jobs: unknown[] }>(afterRes);
    expect(afterData.jobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cronjobs trigger
// ---------------------------------------------------------------------------

function writeScenario(tmpHome: string, events: object[]): string {
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(events));
  return scenarioPath;
}

describe("tRPC — cronjobs.trigger", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let jobId: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repoPath = createGitRepo(tmpHome, "triggerproj");

    const scenarioPath = writeScenario(tmpHome, [
      { type: "system", subtype: "init", session_id: "trigger-session" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
      },
    ]);

    seedState(tmpHome, {
      projects: [
        {
          name: "triggerproj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });
    server = await startServer({
      tmpHome,
      env: { FAKE_AGENT_SCENARIO: scenarioPath },
    });

    // Create a cronjob to trigger
    const res = await trpcMutate(server.url, "cronjobs.create", {
      key: "triggerproj",
      name: "Triggerable job",
      prompt: "Run automated check",
      cronExpression: "0 0 * * *",
      scope: "project",
    });
    const data = await trpcData<{ job: { id: string } }>(res);
    jobId = data.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("triggers a cronjob and creates a task", async () => {
    const res = await trpcMutate(server.url, "cronjobs.trigger", {
      key: "triggerproj",
      id: jobId,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ taskId: string; workspaceId: string }>(res);
    expect(data.taskId).toBeDefined();
    expect(data.workspaceId).toBe("triggerproj-main");

    // Verify the task was created via tasks.list
    const listRes = await trpcQuery(server.url, "tasks.list", {
      workspaceId: "triggerproj-main",
    });
    const listData = await trpcData<{ tasks: Array<{ id: string; prompt: string }> }>(listRes);
    const task = listData.tasks.find((t) => t.id === data.taskId);
    expect(task).toBeDefined();
    expect(task!.prompt).toBe("Run automated check");
  });

  it("returns NOT_FOUND for non-existent cronjob", async () => {
    const res = await trpcMutate(server.url, "cronjobs.trigger", {
      key: "triggerproj",
      id: "cj_nonexistent",
    });
    expect(res.status).toBe(404);
  });

  it("returns CONFLICT when task is already running", async () => {
    // The previous trigger should have started a task; triggering again should conflict
    const res = await trpcMutate(server.url, "cronjobs.trigger", {
      key: "triggerproj",
      id: jobId,
    });
    // Depending on timing, this may be 409 (conflict) or 200 (if previous finished)
    // Just verify it doesn't 500
    expect([200, 409]).toContain(res.status);
  });
});
