// Integration tests for tasks (plan step T.2): `projectTasks.*`, the `band-task` tools of a task's agent and the
// task folder on a worker. A real hub (production bundle, random port, auth on), a real `band-worker` process, local
// bare repositories as the remotes and the scripted ACP stub as the agent. The agent's tools are called over HTTP with
// the `mcp_` token the hub put in the session's `mcpServers`, as the agent would.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeLines, STUB_AGENT_PATH, TEST_TOKEN } from "./helpers/acp-chat";
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

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
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

const REPOS = ["api", "client", "docs"];
let remotes: string;
let home: string;
let server: ServerHandle;
let workerChild: ChildProcess;
let workerHostId: string;
let workerRoot: string;
let workerHome: string;
let workerStubLog: string;

/** A bare repository with one commit on main, which is the `origin` of every clone of it. */
function makeRemote(name: string): string {
  const bare = join(remotes, `${name}.git`);
  git(remotes, "init", "-q", "--bare", "-b", "main", bare);
  const seed = tmp("band-tasks-seed-");
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  return bare;
}

/** Pushes a new commit to a remote's main from a throwaway clone, and returns its sha. */
function advanceRemote(name: string, file: string): string {
  const clone = tmp("band-tasks-adv-");
  git(clone, "clone", "-q", join(remotes, `${name}.git`), ".");
  writeFileSync(join(clone, file), "x\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", `add ${file}`);
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD").trim();
}

const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const mFail = async (proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status).toBeGreaterThanOrEqual(400);
  return (await res.text()).toString();
};

interface TaskView {
  id: string;
  name: string;
  branch: string;
  hostId: string | null;
  folder: string | null;
  chatIds: string[];
  members: Array<{
    repo: string;
    worktreeId: string | null;
    path: string | null;
    role: string | null;
  }>;
}

const taskFolder = (project: string, task: string) =>
  join(workerHome, ".band", "projects", project, "tasks", task);

const createTask = (project: string, input: Record<string, unknown>) =>
  m<{ task: TaskView; chatId: string }>("projectTasks.create", { project, ...input });

const stubRequestsOf = (method: string) =>
  existsSync(workerStubLog)
    ? completeLines(readFileSync(workerStubLog, "utf8"))
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
        .filter((r) => r.method === method)
    : [];

/** The `mcp_` bearer of `band-task` in the session the task's agent started with. */
async function taskBearer(name: string): Promise<string> {
  const request = await waitFor(
    () =>
      stubRequestsOf("session/new").find((r) => String(r.params.cwd).endsWith(`/tasks/${name}`)),
    { label: `session/new for task ${name}`, timeoutMs: 30_000 },
  );
  const servers = request.params.mcpServers as Array<{
    name: string;
    headers: Array<{ name: string; value: string }>;
  }>;
  const entry = servers.find((s) => s.name === "band-task");
  expect(entry, "the session carries the band-task server").toBeDefined();
  return entry?.headers.find((h) => h.name === "Authorization")?.value ?? "";
}

async function taskTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "tasks-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp-proxy/band-task`), {
      requestInit: { headers: { Authorization: bearer } },
    }),
  );
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const text = res.content.map((c) => c.text).join("");
    return { isError: res.isError === true, text, json: () => JSON.parse(text) };
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  remotes = tmp("band-tasks-remotes-");
  home = createTmpHome("band-tasks-");
  const hubRepos = REPOS.map((name) => {
    const bare = makeRemote(name);
    const path = join(home, "repos", name);
    mkdirSync(path, { recursive: true });
    git(path, "clone", "-q", bare, ".");
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(home, { repos: hubRepos });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  const scenario = join(home, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ turns: [{ steps: [{ say: "ok" }] }] }));
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      BAND_TEST_ACP_SCENARIO: scenario,
    },
  });

  workerRoot = tmp("band-tasks-root-");
  for (const name of REPOS)
    git(join(workerRoot), "clone", "-q", join(remotes, `${name}.git`), name);
  workerHome = tmp("band-tasks-whome-");
  workerStubLog = join(workerHome, "stub-log.jsonl");
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "Home box",
  });
  workerHostId = issued.hostId;
  workerChild = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      workerRoot,
      "--state-dir",
      tmp("band-tasks-state-"),
      "--labels",
      "zone=home",
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_LOG: workerStubLog,
        BAND_TEST_ACP_SCENARIO: scenario,
      },
      stdio: "ignore",
    },
  );
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === workerHostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 20_000 },
  );
  // Using a repo on a host the first time records its checkout there, as a user's first worktree does.
  for (const name of REPOS) {
    await m("worktrees.create", {
      repo: name,
      branch: `seed-${name}`,
      hostId: workerHostId,
      hostRepoPath: join(workerRoot, name),
    });
  }
  // `p` holds api and client. `docs` is a registered repo that is not in it.
  await m("projects.create", {
    name: "p",
    repos: [
      { repo: "api", role: "backend" },
      { repo: "client", role: "frontend" },
    ],
    policy: { autonomy: "autonomous", labels: ["zone=home"] },
  });
}, 180_000);

afterAll(async () => {
  workerChild?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

describe("a task with two repos on a worker (S1)", () => {
  let task: TaskView;
  let apiHead: string;

  it("makes the task folder with BRIEF.md and a worktree per repo on the branch from origin's default", async () => {
    // The remote moved on after the worker cloned it, so the base has to come from a fetch.
    apiHead = advanceRemote("api", "newer.txt");
    const created = await createTask("p", {
      branch: "feat/x",
      repos: [{ repo: "api" }, { repo: "client" }],
      brief: "# Do x\nGoal: x works.\n",
    });
    task = created.task;
    expect(task).toMatchObject({ name: "feat-x", branch: "feat/x", hostId: workerHostId });

    const folder = taskFolder("p", "feat-x");
    expect(realpathSync(task.folder as string)).toBe(realpathSync(folder));
    expect(readFileSync(join(folder, "BRIEF.md"), "utf8")).toContain("Goal: x works.");
    for (const repo of ["api", "client"]) {
      const dir = join(folder, repo);
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/x");
      expect(git(dir, "rev-parse", "--git-common-dir").trim()).toContain(workerRoot);
    }
    expect(git(join(folder, "api"), "rev-parse", "HEAD").trim()).toBe(apiHead);
    expect(task.members.map((x) => [x.repo, x.worktreeId])).toEqual([
      ["api", "api-feat-x"],
      ["client", "client-feat-x"],
    ]);
  });

  it("starts a chat whose working directory is the task folder", async () => {
    const started = await waitFor(
      () =>
        stubRequestsOf("session/new").find((r) => String(r.params.cwd).endsWith("/tasks/feat-x")),
      { label: "session/new in the task folder", timeoutMs: 30_000 },
    );
    expect(realpathSync(String(started.params.cwd))).toBe(realpathSync(taskFolder("p", "feat-x")));
    const { chats } = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: `task:${task.id}`,
    });
    expect(chats.map((c) => c.id)).toEqual(task.chatIds);
  });

  it("keeps the member worktrees in the worktree API", async () => {
    const { repos } = await q<{
      repos: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
    }>("repos.list");
    const wt = repos.find((r) => r.name === "client")?.worktrees.find((w) => w.name === "feat/x");
    expect(wt?.hostId).toBe(workerHostId);
  });

  it("refuses a task name that is taken and a branch that already has a worktree", async () => {
    expect(
      await mFail("projectTasks.create", { project: "p", branch: "feat/x", brief: "x" }),
    ).toContain("already has a task named");
    expect(
      await mFail("projectTasks.create", {
        project: "p",
        branch: "feat-x",
        name: "other",
        repos: [{ repo: "api" }],
        brief: "x",
      }),
    ).toContain("already exists");
  });

  it("fails with the reason when no host fits, without splitting the task", async () => {
    const message = await mFail("projectTasks.create", {
      project: "p",
      branch: "feat-gpu",
      repos: [{ repo: "api" }],
      brief: "x",
      placement: { labels: { gpu: "yes" } },
    });
    expect(message).toContain("No online host fits this task");
    expect(message).toContain("gpu=yes");
    const { tasks } = await q<{ tasks: TaskView[] }>("projectTasks.list", { project: "p" });
    expect(tasks.some((t) => t.name === "feat-gpu")).toBe(false);
  });
});

describe("an agent adds repos to its task (S2)", () => {
  let task: TaskView;
  let bearer: string;

  beforeAll(async () => {
    ({ task } = await createTask("p", {
      branch: "feat-empty",
      brief: "Find out what to change.\n",
    }));
    bearer = await taskBearer("feat-empty");
  }, 60_000);

  it("starts with the folder and BRIEF.md only", () => {
    expect(task.members).toEqual([]);
    const folder = taskFolder("p", "feat-empty");
    expect(readFileSync(join(folder, "BRIEF.md"), "utf8")).toContain("task_add_repo");
    expect(existsSync(join(folder, "api"))).toBe(false);
  });

  it("task_add_repo makes the worktree on the task's branch in the folder", async () => {
    const res = await taskTool(bearer, "task_add_repo", { repo: "client" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json()).toMatchObject({
      repo: "client",
      worktreeId: "client-feat-empty",
      role: "frontend",
    });
    const dir = join(taskFolder("p", "feat-empty"), "client");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat-empty");
    const info = await taskTool(bearer, "task_info");
    expect(info.json().members.map((x: { repo: string }) => x.repo)).toEqual(["client"]);
  });

  it("refuses a repo outside the project with a reason, and a repo the task has", async () => {
    const outside = await taskTool(bearer, "task_add_repo", { repo: "docs" });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('Repo "docs" is not in project');
    expect(existsSync(join(taskFolder("p", "feat-empty"), "docs"))).toBe(false);
    const twice = await taskTool(bearer, "task_add_repo", { repo: "client" });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain('already has repo "client"');
  });

  it("refuses a chat that is not a task chat", async () => {
    const res = await fetch(`${server.url}/mcp-proxy/band-task`, {
      method: "POST",
      headers: { Authorization: "Bearer mcp_nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

describe("removing a repo from a task (S3)", () => {
  let bearer: string;
  let dir: string;

  beforeAll(async () => {
    await createTask("p", {
      branch: "feat-rm",
      repos: [{ repo: "api" }, { repo: "client" }],
      brief: "x",
    });
    bearer = await taskBearer("feat-rm");
    dir = join(taskFolder("p", "feat-rm"), "api");
  }, 60_000);

  it("refuses while the member has uncommitted changes, and keeps it", async () => {
    writeFileSync(join(dir, "wip.txt"), "wip\n");
    const res = await taskTool(bearer, "task_remove_repo", { repo: "api" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("uncommitted changes");
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses while the member has a commit that is not on the default branch", async () => {
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "work");
    const res = await taskTool(bearer, "task_remove_repo", { repo: "api" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("1 commit not on main");
    expect(existsSync(dir)).toBe(true);
  });

  it("removes a clean member and leaves the other", async () => {
    const res = await taskTool(bearer, "task_remove_repo", { repo: "client" });
    expect(res.isError, res.text).toBe(false);
    // The checkout is deleted in the background, like any worktree removal.
    await waitFor(
      () => (existsSync(join(taskFolder("p", "feat-rm"), "client")) ? undefined : true),
      {
        label: "client worktree deleted",
        timeoutMs: 20_000,
      },
    );
    const { task } = await q<{ task: TaskView }>("projectTasks.get", {
      task: "feat-rm",
      project: "p",
    });
    expect(task.members.map((x) => x.repo)).toEqual(["api"]);
  });

  it("removes the whole task: worktrees, chat and folder", async () => {
    expect(await mFail("projectTasks.remove", { task: "feat-rm", project: "p" })).toContain(
      "1 commit",
    );
    await m("projectTasks.remove", { task: "feat-rm", project: "p", force: true });
    expect(existsSync(taskFolder("p", "feat-rm"))).toBe(false);
    const { tasks } = await q<{ tasks: TaskView[] }>("projectTasks.list", { project: "p" });
    expect(tasks.some((t) => t.name === "feat-rm")).toBe(false);
  });
});
