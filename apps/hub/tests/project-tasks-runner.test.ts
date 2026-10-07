// Integration tests for multi-repo tasks on runner-started workers (plan step T.4): placement across the labels of
// every member, the runner request, the combined environment, and the hook environment. A real hub (production
// bundle, random port, auth on) runs the bundled `local` hook, wrapped in a script that records the contract
// variables it was given, so a real `band-worker` starts per task. Local bare repositories are the remotes.
// The docker version of the same flow is in project-tasks-docker.test.ts.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "task-runner-shared-secret";
const ROOT = join(import.meta.dirname, "../../..");
const WORKER_BIN = join(ROOT, "apps/worker/bin/band-worker.mjs");
const LOCAL_SPAWN = join(ROOT, "runners/local/spawn.sh");
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
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" });

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

let home: string;
let server: ServerHandle;
let recordDir: string;
let remotes: string;
let bothRequestId = "";

const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const mFail = async (proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TOKEN);
  expect(res.status).toBeGreaterThanOrEqual(400);
  return await res.text();
};

interface TaskView {
  id: string;
  hostId: string | null;
  folder: string | null;
  members: Array<{ repo: string; path: string | null }>;
}
interface HostRequest {
  id: string;
  status: string;
}

/** A bare remote with one commit on main and an environment file whose install writes a marker. */
function makeRemote(name: string, environment: Record<string, unknown>): string {
  const bare = join(remotes, `${name}.git`);
  git(remotes, "init", "-q", "--bare", "-b", "main", bare);
  const seed = tmp("band-task-runner-seed-");
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  mkdirSync(join(seed, ".band"));
  writeFileSync(join(seed, ".band", "environment.json"), JSON.stringify(environment));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  return bare;
}

/**
 * A runner that starts real workers with the `local` hook after writing the contract variables a task
 * needs to a file named by the request id. The bootstrap token is not among them.
 */
function runner(id: string, labels: Record<string, string>) {
  const script = join(recordDir, `${id}-spawn.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
out="${recordDir}/$BAND_REQUEST_ID.env"
{
  echo "RUNNER=${id}"
  echo "BAND_REPO=$BAND_REPO"
  echo "BAND_REPO_URLS=$BAND_REPO_URLS"
  echo "BAND_REPO_IMAGE=$BAND_REPO_IMAGE"
  echo "BAND_TASK_NAME=$BAND_TASK_NAME"
  echo "BAND_TASK_BRANCH=$BAND_TASK_BRANCH"
  echo "BAND_TASK_REPOS=$BAND_TASK_REPOS"
  echo "BAND_LABELS=$BAND_LABELS"
  echo "BAND_ENVIRONMENT=$BAND_ENVIRONMENT"
} >"$out"
exec sh "${LOCAL_SPAWN}"
`,
  );
  chmodSync(script, 0o755);
  return {
    id,
    spawn: script,
    destroy: "bundled:local",
    labels,
    maxConcurrent: 1,
    timeoutSec: 90,
    env: { BAND_WORKER_BIN: WORKER_BIN, BAND_IDLE_EXIT: "120s" },
  };
}

const recorded = (requestId: string): Record<string, string> => {
  const file = join(recordDir, `${requestId}.env`);
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
};

/** The task the hub made once the runner's machine said hello and the request completed. */
const taskOf = async (name: string, requestId: string) => {
  await waitFor(
    async () =>
      (await q<{ requests: HostRequest[] }>("hostRequests.list")).requests.some(
        (r) => r.id === requestId,
      )
        ? undefined
        : true,
    { label: `request ${requestId} completed`, timeoutMs: 150_000, intervalMs: 500 },
  );
  const { tasks } = await q<{ tasks: Array<TaskView & { name: string }> }>("projectTasks.list", {
    project: "p",
  });
  const task = tasks.find((t) => t.name === name);
  expect(task, `task ${name} exists`).toBeDefined();
  return task as TaskView;
};

beforeAll(async () => {
  remotes = tmp("band-task-runner-remotes-");
  recordDir = tmp("band-task-runner-record-");
  home = createTmpHome("band-task-runner-");
  const hubRepos = [
    makeRemote("api", { install: "touch .api-installed", build: { image: "example/api:1" } }),
    makeRemote("client", { install: "touch .client-installed", requires: { node: ">=20" } }),
  ].map((bare) => {
    const name = bare.slice(bare.lastIndexOf("/") + 1, -4);
    const path = join(home, "repos", name);
    mkdirSync(path, { recursive: true });
    git(path, "clone", "-q", bare, ".");
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(home, { repos: hubRepos });
  seedSettings(home, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({ remoteHost: false, tmpHome: home, env: { BAND_SERVE_UI: "false" } });
  await m("projects.create", {
    name: "p",
    repos: [
      { repo: "api", role: "primary" },
      { repo: "client", role: "frontend" },
    ],
    policy: { autonomy: "autonomous" },
  });
}, 180_000);

afterAll(async () => {
  const base = join(server?.home ?? "", ".band", "runners");
  if (existsSync(base)) {
    for (const file of readdirSync(base, { recursive: true }).map(String)) {
      if (!file.endsWith("pid")) continue;
      try {
        process.kill(Number(readFileSync(join(base, file), "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

const twoMembers = [
  { repo: "api", labels: { a: "yes" } },
  { repo: "client", labels: { b: "yes" } },
];

describe("placement of a task across the labels of its members (S1)", () => {
  it("refuses with the member and label that no runner offers", async () => {
    await m("settings.update", { runners: [runner("only-a", { a: "yes" })] });
    const message = await mFail("projectTasks.create", {
      project: "p",
      branch: "feat/none",
      brief: "x",
      repos: twoMembers,
      start: false,
    });
    expect(message).toContain("no runner can start one");
    expect(message).toContain("b=yes (repo client)");
    expect(message).toContain("runner only-a");
    // Nothing was recorded for a task that could not be placed.
    expect((await q<{ requests: HostRequest[] }>("hostRequests.list")).requests).toEqual([]);
  });

  it("refuses two members that ask for different values of one label", async () => {
    const message = await mFail("projectTasks.create", {
      project: "p",
      branch: "feat/clash",
      brief: "x",
      repos: [
        { repo: "api", labels: { zone: "eu" } },
        { repo: "client", labels: { zone: "us" } },
      ],
      start: false,
    });
    expect(message).toContain("zone=us (repo client) conflicts with zone=eu");
  });

  it("places the task on the runner that offers every label, and makes both worktrees there", async () => {
    await m("settings.update", {
      runners: [runner("only-a", { a: "yes" }), runner("both", { a: "yes", b: "yes" })],
    });
    const created = await m<{ provisioning?: { requestId: string } }>("projectTasks.create", {
      project: "p",
      branch: "feat/both",
      brief: "# both\n",
      repos: twoMembers,
      start: false,
    });
    const requestId = created.provisioning?.requestId;
    expect(requestId, "no host fits, so a runner is asked").toBeTruthy();
    bothRequestId = requestId as string;

    const task = await taskOf("feat-both", bothRequestId);
    const env = recorded(requestId as string);
    expect(env.RUNNER, "the runner offering a and b took the request").toBe("both");
    expect(env.BAND_LABELS.split(",").sort()).toEqual(["a=yes", "b=yes"]);

    expect(task.hostId).toBeTruthy();
    const folder = task.folder as string;
    expect(existsSync(join(folder, "BRIEF.md"))).toBe(true);
    for (const repo of ["api", "client"]) {
      expect(git(join(folder, repo), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/both");
    }
    // The install of each member ran in its own worktree.
    await waitFor(
      () =>
        existsSync(join(folder, "api", ".api-installed")) &&
        existsSync(join(folder, "client", ".client-installed")),
      { label: "each member's install ran", timeoutMs: 60_000, intervalMs: 500 },
    );
  }, 180_000);
});

describe("the environment of a runner task (S3)", () => {
  it("passes every member's URL and the task layout to the hook, with the primary's image", async () => {
    const env = recorded(bothRequestId);
    expect(env.BAND_REPO).toBe("api");
    expect(env.BAND_REPO_URLS.split(",").map((u) => u.replace(/^file:\/\//, ""))).toEqual([
      expect.stringMatching(/api\.git$/),
      expect.stringMatching(/client\.git$/),
    ]);
    expect(env.BAND_TASK_NAME).toBe("feat-both");
    expect(env.BAND_TASK_BRANCH).toBe("feat/both");
    expect(env.BAND_TASK_REPOS).toBe("api,client");
    expect(env.BAND_REPO_IMAGE).toBe("example/api:1");
    // The primary's file decides, with the other member's `requires` added.
    expect(JSON.parse(env.BAND_ENVIRONMENT)).toMatchObject({
      build: { image: "example/api:1" },
      requires: { node: ">=20" },
    });
    expect(Object.values(env).join("\n")).not.toMatch(/bwb_/);
  });

  it("uses the project's .band/environment.json over the primary member's image", async () => {
    const { head } = await q<{ head: string | null }>("context.tree", { name: "p" });
    expect(head).toBeTruthy();
    await m("context.write", {
      name: "p",
      path: ".band/environment.json",
      content: JSON.stringify({
        build: { image: "example/project:2" },
        install: "touch project-installed",
      }),
      message: "project environment",
    });
    const created = await m<{ provisioning?: { requestId: string } }>("projectTasks.create", {
      project: "p",
      branch: "feat/proj-env",
      brief: "# env\n",
      repos: twoMembers,
      start: false,
    });
    const requestId = created.provisioning?.requestId as string;
    expect(requestId).toBeTruthy();
    const task = await taskOf("feat-proj-env", requestId);
    const env = recorded(requestId);
    expect(env.BAND_REPO_IMAGE).toBe("example/project:2");
    expect(JSON.parse(env.BAND_ENVIRONMENT)).toMatchObject({
      build: { image: "example/project:2" },
    });
    // The file's install ran once in the task folder, after the members existed.
    expect(existsSync(join(task.folder as string, "project-installed"))).toBe(true);
  }, 180_000);

  it("refuses a project environment that builds from a dockerfile", async () => {
    await m("context.write", {
      name: "p",
      path: ".band/environment.json",
      content: JSON.stringify({ build: { dockerfile: "Dockerfile" } }),
      message: "dockerfile environment",
    });
    expect(
      await mFail("projectTasks.create", {
        project: "p",
        branch: "feat/docker-env",
        brief: "x",
        repos: twoMembers,
        start: false,
      }),
    ).toContain("builds from a dockerfile or devcontainer");
  });
});
