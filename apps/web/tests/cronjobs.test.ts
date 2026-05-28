import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "cronjob-test-token";

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
    tmpHome = createTmpHome("band-cronjob-test-");
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
    const res = await trpcQuery(server.url, "cronjobs.list", undefined, DEFAULT_TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: unknown[] }>(res);
    expect(data.jobs).toEqual([]);
  });

  it("cronjobs.create creates a project-scoped job", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "myproject",
        name: "Daily dep check",
        prompt: "Check for outdated dependencies",
        cronExpression: "0 9 * * 1",
        scope: "project",
        enabled: true,
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string; name: string; scope: string } }>(res);
    expect(data.job.name).toBe("Daily dep check");
    expect(data.job.scope).toBe("project");
    expect(data.job.id).toMatch(/^cj_\d+$/);
  });

  it("cronjobs.create rejects invalid cron expression", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "myproject",
        name: "Bad cron",
        prompt: "This should fail",
        cronExpression: "not a cron",
        scope: "project",
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(400);
  });

  it("cronjobs.create rejects workspace scope without workspaceId", async () => {
    // CronjobWorkspaceMissingError path: the service requires `workspaceId`
    // for workspace-scoped jobs and the router maps the typed error to a
    // 400 Bad Request. Pinning the path here keeps the validation honest
    // — without this test, a refactor that lost the check would only
    // surface at runtime against a real workspace-scoped create.
    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "myproject",
        name: "Missing workspace",
        prompt: "Should be rejected",
        cronExpression: "0 9 * * 1",
        scope: "workspace",
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(400);
  });

  it("cronjobs.list returns the created job", async () => {
    const res = await trpcQuery(server.url, "cronjobs.list", undefined, DEFAULT_TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: Array<{ name: string; fileKey: string }> }>(res);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].name).toBe("Daily dep check");
    expect(data.jobs[0].fileKey).toBe("myproject");
  });

  it("cronjobs.list filters by project", async () => {
    const res = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: unknown[] }>(res);
    expect(data.jobs).toHaveLength(1);

    const empty = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "nonexistent" },
      DEFAULT_TOKEN,
    );
    const emptyData = await trpcData<{ jobs: unknown[] }>(empty);
    expect(emptyData.jobs).toEqual([]);
  });

  it("cronjobs.create creates a second job", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "myproject",
        name: "Code quality sweep",
        prompt: "Run linting and fix issues",
        cronExpression: "0 */6 * * *",
        scope: "project",
        enabled: false,
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { enabled: boolean } }>(res);
    expect(data.job.enabled).toBe(false);
  });

  it("cronjobs.list returns both jobs", async () => {
    const res = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ jobs: unknown[] }>(res);
    expect(data.jobs).toHaveLength(2);
  });

  it("cronjobs.get returns a specific job", async () => {
    const listRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[0].id;

    const res = await trpcQuery(
      server.url,
      "cronjobs.get",
      { key: "myproject", id: jobId },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string; name: string } }>(res);
    expect(data.job.id).toBe(jobId);
  });

  it("cronjobs.get returns NOT_FOUND for missing job", async () => {
    const res = await trpcQuery(
      server.url,
      "cronjobs.get",
      { key: "myproject", id: "cj_nonexistent" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(404);
  });

  it("cronjobs.update modifies job properties", async () => {
    const listRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[0].id;

    const res = await trpcMutate(
      server.url,
      "cronjobs.update",
      {
        key: "myproject",
        id: jobId,
        name: "Updated name",
        cronExpression: "0 12 * * *",
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { name: string; cronExpression: string } }>(res);
    expect(data.job.name).toBe("Updated name");
    expect(data.job.cronExpression).toBe("0 12 * * *");
  });

  it("cronjobs.update rejects invalid cron expression", async () => {
    const listRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[0].id;

    const res = await trpcMutate(
      server.url,
      "cronjobs.update",
      {
        key: "myproject",
        id: jobId,
        cronExpression: "invalid",
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(400);
  });

  it("cronjobs.update toggles enabled state", async () => {
    const listRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    const listData = await trpcData<{ jobs: Array<{ id: string; enabled: boolean }> }>(listRes);
    const job = listData.jobs[0];

    const res = await trpcMutate(
      server.url,
      "cronjobs.update",
      {
        key: "myproject",
        id: job.id,
        enabled: !job.enabled,
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { enabled: boolean } }>(res);
    expect(data.job.enabled).toBe(!job.enabled);
  });

  it("cronjobs.update returns NOT_FOUND for missing job", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.update",
      {
        key: "myproject",
        id: "cj_nonexistent",
        name: "nope",
      },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(404);
  });

  it("cronjobs.delete removes a job", async () => {
    const listRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    const listData = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    const jobId = listData.jobs[1].id;

    const res = await trpcMutate(
      server.url,
      "cronjobs.delete",
      { key: "myproject", id: jobId },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);

    const afterRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "myproject" },
      DEFAULT_TOKEN,
    );
    const afterData = await trpcData<{ jobs: unknown[] }>(afterRes);
    expect(afterData.jobs).toHaveLength(1);
  });

  it("cronjobs.delete returns NOT_FOUND for missing job", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.delete",
      { key: "myproject", id: "cj_nonexistent" },
      DEFAULT_TOKEN,
    );
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
    tmpHome = createTmpHome("band-cronjob-cleanup-");
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
    const createRes = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "removeme",
        name: "Project job",
        prompt: "Do something",
        cronExpression: "0 * * * *",
        scope: "project",
      },
      DEFAULT_TOKEN,
    );
    expect(createRes.status).toBe(200);

    // Verify the job exists
    const listRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "removeme" },
      DEFAULT_TOKEN,
    );
    const listData = await trpcData<{ jobs: unknown[] }>(listRes);
    expect(listData.jobs).toHaveLength(1);

    // Remove the project
    const removeRes = await trpcMutate(
      server.url,
      "projects.remove",
      { name: "removeme" },
      DEFAULT_TOKEN,
    );
    expect(removeRes.status).toBe(200);

    // Verify the cronjobs are gone
    const afterRes = await trpcQuery(
      server.url,
      "cronjobs.list",
      { project: "removeme" },
      DEFAULT_TOKEN,
    );
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
    tmpHome = createTmpHome("band-cronjob-trigger-");
    const repoPath = createGitRepo(tmpHome, "triggerproj");

    // Long-running scenario: the agent emits `init` and then sleeps for 5s
    // before the terminal `result`. The 5s window is what makes the
    // "returns CONFLICT when task is already running" assertion below
    // deterministic — the previous fake-agent scenario completed in tens of
    // ms, so a slower test runner would race the result event past the
    // second trigger and turn the conflict check into a coin flip.
    const scenarioPath = writeScenario(tmpHome, [
      { type: "system", subtype: "init", session_id: "trigger-session" },
      { _sleep_ms: 5000 },
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
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
      ],
    });
    server = await startServer({
      tmpHome,
      env: { FAKE_AGENT_SCENARIO: scenarioPath },
    });

    // Create a cronjob to trigger
    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "triggerproj",
        name: "Triggerable job",
        prompt: "Run automated check",
        cronExpression: "0 0 * * *",
        scope: "project",
      },
      DEFAULT_TOKEN,
    );
    const data = await trpcData<{ job: { id: string } }>(res);
    jobId = data.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("triggers a cronjob and creates a task", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "triggerproj", id: jobId },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ taskId: string; workspaceId: string }>(res);
    expect(data.taskId).toBeDefined();
    expect(data.workspaceId).toBe("triggerproj-main");

    // Verify the task was created via tasks.list
    const listRes = await trpcQuery(
      server.url,
      "tasks.list",
      { workspaceId: "triggerproj-main" },
      DEFAULT_TOKEN,
    );
    const listData = await trpcData<{ tasks: Array<{ id: string; prompt: string }> }>(listRes);
    const task = listData.tasks.find((t) => t.id === data.taskId);
    expect(task).toBeDefined();
    expect(task!.prompt).toBe("Run automated check");
  });

  it("returns NOT_FOUND for non-existent cronjob", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "triggerproj", id: "cj_nonexistent" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(404);
  });

  it("returns CONFLICT when task is already running", async () => {
    // The fake-agent scenario above sleeps for 5s before emitting `result`,
    // so by the time this test runs the task started by the first
    // `triggers a cronjob and creates a task` case is still in-flight.
    // Belt-and-braces: poll `tasks.list` until we see `status: "running"`
    // before firing the second trigger, so the assertion does not depend
    // on wall-clock margin between the two `it` blocks at all. If the
    // agent ever completes faster than expected the poll fails loudly
    // instead of the conflict check silently flipping to 200.
    await expect
      .poll(
        async () => {
          const listRes = await trpcQuery(
            server.url,
            "tasks.list",
            { workspaceId: "triggerproj-main", status: "running" },
            DEFAULT_TOKEN,
          );
          const listData = await trpcData<{ tasks: unknown[] }>(listRes);
          return listData.tasks.length;
        },
        { timeout: 4000, interval: 50 },
      )
      .toBeGreaterThan(0);

    // Assert the exact status code rather than a [200, 409] union — the
    // union form silently passes if the conflict path ever stops firing.
    const res = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "triggerproj", id: jobId },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(409);
  });
});
