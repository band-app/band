// Integration tests for dispatch from a project coordinator (plan step 6.3): the `tasks_create` tool of
// `/mcp-proxy/band-coordinator` (plan steps 6.3 and T.2). A real hub (production bundle, random port, auth on), real git repos and a real
// `band-worker` process that carries the label the projects ask for. The coding agent is the scripted ACP stub on
// the hub and on the worker. The coordinator's tool is called over HTTP with the `mcp_` token the hub gave its
// session, exactly as the agent would.

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
import {
  completeLines,
  STUB_AGENT_PATH,
  type StubRequest,
  stubRequests,
  TEST_TOKEN,
} from "./helpers/acp-chat";
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

function makeRepo(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), `${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

let home: string;
let server: ServerHandle;
let workerChild: ChildProcess;
let workerHostId: string;
let workerRoot: string;
let workerStubLog: string;
let workerHome: string;

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
/** A mutation that must fail: returns the error message. */
const mFail = async (proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status).toBeGreaterThanOrEqual(400);
  return (await res.text()).toString();
};

interface ProjectView {
  id: string;
  name: string;
}
interface Dispatch {
  id: string;
  status: string;
  error: string | null;
  repos: string[];
  branch: string;
}
interface Group {
  id: string;
  title: string;
  branch: string;
  mergeOrder: string[];
  members: Array<{
    repo: string;
    worktreeId: string | null;
    hostId: string | null;
    mergeOrder: number;
  }>;
}

const createProject = (name: string, policy: Record<string, unknown>) =>
  m<{ project: ProjectView }>("projects.create", {
    name,
    repos: [{ repo: "api" }, { repo: "client" }],
    policy,
  }).then((r) => r.project);

const sessionNewFor = (slug: string): Promise<StubRequest> =>
  waitFor(() => stubRequests(home, "session/new").find((r) => r.cwd.endsWith(slug)), {
    label: `session/new for ${slug}`,
    timeoutMs: 30_000,
  });

const bearerOf = (request: StubRequest): string => {
  const entries = request.params.mcpServers as Array<{
    headers: Array<{ name: string; value: string }>;
  }>;
  return entries[0].headers.find((h) => h.name === "Authorization")?.value ?? "";
};

/** The bearer of a new project's coordinator session. */
async function coordinatorOf(name: string): Promise<string> {
  return bearerOf(await sessionNewFor(`/projects/${name}`));
}

async function callTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "dispatch-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp-proxy/band-coordinator`), {
      requestInit: { headers: { Authorization: bearer } },
    }),
  );
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const text = res.content.map((c) => c.text).join("");
    return {
      isError: res.isError === true,
      text,
      json: () => JSON.parse(text) as Record<string, unknown>,
    };
  } finally {
    await client.close();
  }
}

/** The folder of a task of a project on the worker: `<worker BAND_HOME>/projects/<project>/tasks/<task>`. */
const taskFolder = (project: string, task: string) =>
  join(workerHome, ".band", "projects", project, "tasks", task);
const briefOf = (project: string, task: string) => join(taskFolder(project, task), "BRIEF.md");

const workerPrompts = (): string[] =>
  existsSync(workerStubLog)
    ? completeLines(readFileSync(workerStubLog, "utf8"))
        .map((l) => JSON.parse(l) as { method: string; params: unknown })
        .filter((r) => r.method === "session/prompt")
        .map((r) => JSON.stringify(r.params))
    : [];

const dispatchesOf = (project: string, status?: string) =>
  q<{ dispatches: Dispatch[] }>("projects.dispatches", { project, status }).then(
    (r) => r.dispatches,
  );

const worktreeExists = async (id: string) => {
  const { repos } = await q<{ repos: Array<{ name: string; worktrees: Array<{ name: string }> }> }>(
    "repos.list",
  );
  return repos.some((r) => r.worktrees.some((w) => `${r.name}-${w.name}` === id));
};

beforeAll(async () => {
  home = createTmpHome("band-dispatch-");
  const repos = ["api", "client"].map((name) => {
    const path = join(home, "repos", name);
    makeRepo(path, name);
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(home, { repos });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  const scenario = join(home, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [{ match: "^hold", steps: [{ waitForCancel: true }] }, { steps: [{ say: "ok" }] }],
    }),
  );
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

  // One real worker with the label the projects ask for, and a checkout of each repo under its root.
  workerRoot = tmp("band-dispatch-root-");
  for (const name of ["api", "client"]) makeRepo(join(workerRoot, name), name);
  workerHome = tmp("band-dispatch-whome-");
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
      tmp("band-dispatch-state-"),
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
  for (const name of ["api", "client"]) {
    await m("worktrees.create", {
      repo: name,
      branch: `seed-${name}`,
      hostId: workerHostId,
      hostRepoPath: join(workerRoot, name),
    });
  }
}, 180_000);

afterAll(async () => {
  workerChild?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

describe("an autonomous coordinator dispatches (S1)", () => {
  const brief = "# Add the search endpoint\nGoal: GET /search returns matches.\n";
  let bearer: string;

  beforeAll(async () => {
    await createProject("auto", {
      autonomy: "autonomous",
      labels: ["zone=home"],
      models: { worker: "haiku" },
    });
    bearer = await coordinatorOf("auto");
  }, 60_000);

  it("creates the task on the matching host with BRIEF.md, a worktree and a worker chat on the worker model", async () => {
    const res = await callTool(bearer, "tasks_create", {
      repos: [{ repo: "api" }],
      branch: "feat-search",
      title: "Search endpoint",
      brief,
      scenarios: ["GET /search?q=a returns 200", "an empty query returns 400"],
      placement: { labels: { zone: "home" } },
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.json()).toMatchObject({
      status: "dispatched",
      name: "feat-search",
      hostId: workerHostId,
      worktrees: [{ repo: "api", worktreeId: "api-feat-search" }],
    });

    const { repos } = await q<{
      repos: Array<{
        name: string;
        worktrees: Array<{ name: string; path: string; hostId?: string; projectId?: string }>;
      }>;
    }>("repos.list");
    const worktree = repos
      .find((r) => r.name === "api")
      ?.worktrees.find((w) => w.name === "feat-search");
    expect(worktree?.hostId).toBe(workerHostId);
    // The worktree is a folder of the task.
    expect(realpathSync(worktree?.path ?? "")).toBe(
      realpathSync(join(taskFolder("auto", "feat-search"), "api")),
    );

    const text = readFileSync(briefOf("auto", "feat-search"), "utf8");
    expect(text).toContain("Search endpoint");
    expect(text).toContain("Goal: GET /search returns matches.");
    expect(text).toContain("- S1: GET /search?q=a returns 200");
    expect(text).toContain("- S2: an empty query returns 400");
    // The brief is in the task folder, so the repository has no change for it.
    expect(git(join(taskFolder("auto", "feat-search"), "api"), "status", "--porcelain")).toBe("");

    const { task } = await q<{ task: { id: string; chatIds: string[] } }>("projectTasks.get", {
      task: "feat-search",
      project: "auto",
    });
    const { chats } = await q<{ chats: Array<{ agent: string; model: string }> }>("chats.list", {
      worktreeId: `task:${task.id}`,
    });
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ agent: "claude-code", model: "haiku" });
    const prompt = await waitFor(() => workerPrompts().find((p) => p.includes("BRIEF.md")), {
      label: "worker prompt that points at the brief",
      timeoutMs: 30_000,
    });
    expect(prompt).toContain("source of truth");
    // The agent runs in the task folder.
    const started = await waitFor(
      () =>
        completeLines(readFileSync(workerStubLog, "utf8"))
          .map((l) => JSON.parse(l) as { method: string; params: { cwd?: string } })
          .find((r) => r.method === "session/new" && r.params.cwd?.endsWith("/tasks/feat-search")),
      { label: "session/new in the task folder", timeoutMs: 30_000 },
    );
    expect(realpathSync(started.params.cwd as string)).toBe(
      realpathSync(taskFolder("auto", "feat-search")),
    );
  });

  it("lists the dispatched task for the coordinator and keeps no approval request", async () => {
    const list = await callTool(bearer, "tasks_list");
    expect(JSON.stringify(list.json())).toContain("api-feat-search");
    expect(await dispatchesOf("auto")).toEqual([]);
  });
});

describe("a steer project asks the user first (S2)", () => {
  let bearer: string;
  const call = (branch: string) =>
    callTool(bearer, "tasks_create", {
      repos: [{ repo: "client" }],
      branch,
      brief: `Do ${branch}`,
      scenarios: ["it works"],
      placement: { labels: { zone: "home" } },
    });

  beforeAll(async () => {
    await createProject("steer", { autonomy: "steer", labels: ["zone=home"] });
    bearer = await coordinatorOf("steer");
  }, 60_000);

  it("answers pending approval and creates nothing", async () => {
    const res = await call("feat-approve");
    expect(res.isError, res.text).toBe(false);
    expect(res.json()).toMatchObject({ status: "pending approval" });
    expect(await worktreeExists("client-feat-approve")).toBe(false);
    const pending = await dispatchesOf("steer", "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ repos: ["client"], branch: "feat-approve" });
  });

  it("dispatches on approval, once", async () => {
    const [request] = await dispatchesOf("steer", "pending");
    const { result } = await m<{ result: { worktrees: Array<{ worktreeId: string | null }> } }>(
      "projects.approveDispatch",
      { requestId: request.id },
    );
    expect(result.worktrees.map((w) => w.worktreeId)).toEqual(["client-feat-approve"]);
    expect(existsSync(briefOf("steer", "feat-approve"))).toBe(true);
    expect((await dispatchesOf("steer", "approved"))[0].id).toBe(request.id);
    expect(await mFail("projects.approveDispatch", { requestId: request.id })).toContain(
      "already approved",
    );
  });

  it("drops the call on rejection", async () => {
    await call("feat-reject");
    const [request] = await dispatchesOf("steer", "pending");
    await m("projects.rejectDispatch", { requestId: request.id });
    expect((await dispatchesOf("steer", "rejected"))[0].id).toBe(request.id);
    expect(await worktreeExists("client-feat-reject")).toBe(false);
    expect(await mFail("projects.approveDispatch", { requestId: request.id })).toContain(
      "already rejected",
    );
  });
});

describe("approval edge cases", () => {
  let bearer: string;

  beforeAll(async () => {
    await createProject("edge", { autonomy: "steer", labels: ["zone=home"] });
    bearer = await coordinatorOf("edge");
  }, 60_000);

  it("keeps a request pending when the re-check at approval refuses it", async () => {
    const res = await callTool(bearer, "tasks_create", {
      repos: [{ repo: "client" }],
      branch: "feat-late",
      brief: "x",
      scenarios: [],
      placement: { labels: { zone: "home" } },
    });
    expect(res.json()).toMatchObject({ status: "pending approval" });
    const [request] = await dispatchesOf("edge", "pending");
    // The branch is taken while the request waits.
    await m("worktrees.create", { repo: "client", branch: "feat-late" });
    expect(await mFail("projects.approveDispatch", { requestId: request.id })).toContain(
      "already exists",
    );
    expect((await dispatchesOf("edge", "pending")).map((d) => d.id)).toEqual([request.id]);
    await m("projects.rejectDispatch", { requestId: request.id });
    expect(await dispatchesOf("edge", "pending")).toEqual([]);
  }, 60_000);

  it("refuses approval and rejection from a non-admin token", async () => {
    const res = await callTool(bearer, "tasks_create", {
      repos: [{ repo: "api" }],
      branch: "feat-admin",
      brief: "x",
      scenarios: [],
      placement: { labels: { zone: "home" } },
    });
    expect(res.json()).toMatchObject({ status: "pending approval" });
    const [request] = await dispatchesOf("edge", "pending");
    const { token } = await m<{ token: string }>("tokens.createDevice", { label: "viewer" });
    for (const proc of ["projects.approveDispatch", "projects.rejectDispatch"]) {
      const forbidden = await trpcMutate(server.url, proc, { requestId: request.id }, token);
      expect(forbidden.status).toBe(403);
    }
    expect((await dispatchesOf("edge", "pending")).map((d) => d.id)).toEqual([request.id]);
    await m("projects.rejectDispatch", { requestId: request.id });
  }, 60_000);
});

describe("the policy refuses a dispatch (S3)", () => {
  const base = (branch: string, extra: Record<string, unknown> = {}) => ({
    repos: [{ repo: "api" }],
    branch,
    brief: "x",
    scenarios: [],
    ...extra,
  });

  it("refuses isolation below the floor", async () => {
    await createProject("floor", { autonomy: "autonomous", isolationFloor: "container" });
    const bearer = await coordinatorOf("floor");
    const res = await callTool(
      bearer,
      "tasks_create",
      base("feat-floor", { placement: { isolation: "worktree" } }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("isolation worktree is below the floor");
    expect(res.text).toContain("container");
    expect(await worktreeExists("api-feat-floor")).toBe(false);
  });

  it("refuses labels outside the project's", async () => {
    await createProject("labels", { autonomy: "autonomous", labels: ["zone=home"] });
    const bearer = await coordinatorOf("labels");
    const res = await callTool(
      bearer,
      "tasks_create",
      base("feat-cloud", { placement: { labels: { zone: "cloud" } } }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("zone=cloud is not among the labels");
    expect(await worktreeExists("api-feat-cloud")).toBe(false);
  });

  it("refuses a dispatch past maxConcurrent", async () => {
    await createProject("capped", { autonomy: "autonomous", maxConcurrent: 1 });
    const bearer = await coordinatorOf("capped");

    // One running worker fills the slot.
    await m("worktrees.create", { repo: "api", branch: "busy", projectId: "capped" });
    const { chat } = await m<{ chat: { id: string } }>("chats.create", {
      worktreeId: "api-busy",
      name: "busy",
    });
    const sent = await callTool(bearer, "chats_send", { chatId: chat.id, message: "hold" });
    expect(sent.isError, sent.text).toBe(false);
    await waitFor(
      async () => {
        const status = await callTool(bearer, "project_status");
        return (status.json() as { running: number }).running === 1 ? true : undefined;
      },
      { label: "one worker running", timeoutMs: 30_000 },
    );
    const refused = await callTool(bearer, "tasks_create", base("feat-over"));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("1 worker agents are already running");
    expect(refused.text).toContain("allows 1 at once");
    expect(await worktreeExists("api-feat-over")).toBe(false);
  }, 90_000);

  it("refuses in observe mode, a repo outside the project and a taken branch", async () => {
    await createProject("watch", { autonomy: "observe" });
    const observe = await callTool(await coordinatorOf("watch"), "tasks_create", base("feat-w"));
    expect(observe.isError).toBe(true);
    expect(observe.text).toContain("observe mode");

    // The checks below need an autonomous project and a branch that is already taken, so they
    // make their own and do not depend on what the S1 tests dispatched.
    await createProject("strict", { autonomy: "autonomous", labels: ["zone=home"] });
    const bearer = await coordinatorOf("strict");
    await m("worktrees.create", { repo: "api", branch: "feat-taken" });
    const outside = await callTool(
      bearer,
      "tasks_create",
      base("feat-x", { repos: [{ repo: "ghost" }] }),
    );
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('Repo "ghost" is not in project');
    const taken = await callTool(bearer, "tasks_create", base("feat-taken"));
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("already exists");
    const twice = await callTool(bearer, "tasks_create", {
      ...base("feat-twice"),
      repos: [{ repo: "api" }, { repo: "api" }],
    });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain("A repo appears twice");
  }, 90_000);
});

describe("a task with two repos (S4)", () => {
  let bearer: string;

  beforeAll(async () => {
    await createProject("duo", { autonomy: "autonomous", labels: ["zone=home"] });
    bearer = await coordinatorOf("duo");
  }, 60_000);

  it("creates a worktree per repo in one task folder with the repos and the PR order in the brief", async () => {
    const res = await callTool(bearer, "tasks_create", {
      repos: [
        { repo: "api", role: "backend" },
        { repo: "client", role: "frontend" },
      ],
      branch: "feat-checkout",
      title: "Checkout flow",
      brief: "Add the checkout flow.\n",
      scenarios: ["checkout completes"],
    });
    expect(res.isError, res.text).toBe(false);
    const body = res.json() as {
      taskId: string;
      folder: string;
      worktrees: Array<{ worktreeId: string }>;
    };
    expect(body.taskId).toMatch(/^tsk-/);
    expect(body.worktrees.map((w) => w.worktreeId)).toEqual([
      "api-feat-checkout",
      "client-feat-checkout",
    ]);

    const text = readFileSync(briefOf("duo", "feat-checkout"), "utf8");
    expect(text).toContain("- api (backend)");
    expect(text).toContain("- client (frontend)");
    expect(text).toContain("Pull request order: 1. api, 2. client");
    expect(text).toContain("- S1: checkout completes");
    for (const repo of ["api", "client"]) {
      const dir = join(taskFolder("duo", "feat-checkout"), repo);
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat-checkout");
    }

    const { groups } = await q<{ groups: Group[] }>("projects.groups", { project: "duo" });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: body.taskId,
      branch: "feat-checkout",
      mergeOrder: ["api", "client"],
    });
    expect(groups[0].members.map((x) => [x.repo, x.worktreeId, x.hostId])).toEqual([
      ["api", "api-feat-checkout", workerHostId],
      ["client", "client-feat-checkout", workerHostId],
    ]);
  });

  it("fails with the reason when no host has the label, and creates nothing", async () => {
    const res = await callTool(bearer, "tasks_create", {
      repos: [{ repo: "api" }],
      branch: "feat-nowhere",
      brief: "x",
      scenarios: [],
      host: "ghost-host",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Unknown host "ghost-host"');
    expect(await worktreeExists("api-feat-nowhere")).toBe(false);
  });
});
