// Integration tests for dispatch from a project coordinator (plan step 6.3): the `worktrees_create` tool of
// `/mcp-proxy/band-coordinator`. A real hub (production bundle, random port, auth on), real git repos and a real
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
import { STUB_AGENT_PATH, type StubRequest, stubRequests, TEST_TOKEN } from "./helpers/acp-chat";
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
  branch: string;
  mode: string;
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
  return bearerOf(await sessionNewFor(`coordinator-${name}`));
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

const briefOf = (repo: string, branch: string) =>
  join(workerRoot, ".band-worktrees", repo, branch, ".am", "BRIEF.md");

const workerPrompts = (): string[] =>
  existsSync(workerStubLog)
    ? readFileSync(workerStubLog, "utf8")
        .split("\n")
        .filter(Boolean)
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
  const workerHome = tmp("band-dispatch-whome-");
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

  it("creates the worktree on the matching host with BRIEF.md and a worker chat on the worker model", async () => {
    const res = await callTool(bearer, "worktrees_create", {
      repo: "api",
      branch: "feat-search",
      title: "Search endpoint",
      brief,
      scenarios: ["GET /search?q=a returns 200", "an empty query returns 400"],
      placement: { labels: { zone: "home" } },
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.json()).toMatchObject({
      status: "dispatched",
      worktrees: [{ repo: "api", worktreeId: "api-feat-search" }],
    });

    const { repos } = await q<{
      repos: Array<{
        name: string;
        worktrees: Array<{ name: string; hostId?: string; projectId?: string }>;
      }>;
    }>("repos.list");
    const worktree = repos
      .find((r) => r.name === "api")
      ?.worktrees.find((w) => w.name === "feat-search");
    expect(worktree?.hostId).toBe(workerHostId);

    const file = briefOf("api", "feat-search");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Search endpoint");
    expect(text).toContain("Goal: GET /search returns matches.");
    expect(text).toContain("- S1: GET /search?q=a returns 200");
    expect(text).toContain("- S2: an empty query returns 400");
    // The brief is not part of the repository's changes.
    const dir = join(workerRoot, ".band-worktrees", "api", "feat-search");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(workerRoot, "api", ".git", "info", "exclude"), "utf8")).toContain(
      ".am/",
    );

    const { chats } = await q<{ chats: Array<{ agent: string; model: string }> }>("chats.list", {
      worktreeId: "api-feat-search",
    });
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ agent: "claude-code", model: "haiku" });
    const prompt = await waitFor(() => workerPrompts().find((p) => p.includes(".am/BRIEF.md")), {
      label: "worker prompt that points at the brief",
      timeoutMs: 30_000,
    });
    expect(prompt).toContain("source of truth");
  });

  it("lists the dispatched worktree for the coordinator and keeps no approval request", async () => {
    const list = await callTool(bearer, "worktrees_list");
    expect(JSON.stringify(list.json())).toContain("api-feat-search");
    expect(await dispatchesOf("auto")).toEqual([]);
  });
});

describe("a steer project asks the user first (S2)", () => {
  let bearer: string;
  const call = (branch: string) =>
    callTool(bearer, "worktrees_create", {
      repo: "client",
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
    const { result } = await m<{ result: { worktrees: Array<{ worktreeId: string }> } }>(
      "projects.approveDispatch",
      { requestId: request.id },
    );
    expect(result.worktrees.map((w) => w.worktreeId)).toEqual(["client-feat-approve"]);
    expect(existsSync(briefOf("client", "feat-approve"))).toBe(true);
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
    const res = await callTool(bearer, "worktrees_create", {
      repo: "client",
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
    const res = await callTool(bearer, "worktrees_create", {
      repo: "api",
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
    repo: "api",
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
      "worktrees_create",
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
      "worktrees_create",
      base("feat-cloud", { placement: { labels: { zone: "cloud" } } }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("zone=cloud is not among the labels");
    expect(await worktreeExists("api-feat-cloud")).toBe(false);
  });

  it("refuses a dispatch past maxConcurrent, and a group that would pass it", async () => {
    await createProject("capped", { autonomy: "autonomous", maxConcurrent: 1 });
    const bearer = await coordinatorOf("capped");
    // A group of two cannot fit in one slot.
    const group = await callTool(bearer, "worktrees_create", {
      group: {
        repos: [{ repo: "api" }, { repo: "client" }],
        mode: "split",
        mergeOrder: ["api", "client"],
      },
      branch: "feat-two",
      brief: "x",
      scenarios: [],
    });
    expect(group.isError).toBe(true);
    expect(group.text).toContain("allows 1 at once");

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
    const refused = await callTool(bearer, "worktrees_create", base("feat-over"));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("1 worker agents are already running");
    expect(refused.text).toContain("allows 1 at once");
    expect(await worktreeExists("api-feat-over")).toBe(false);
  }, 90_000);

  it("refuses in observe mode, a repo outside the project and a taken branch", async () => {
    await createProject("watch", { autonomy: "observe" });
    const observe = await callTool(
      await coordinatorOf("watch"),
      "worktrees_create",
      base("feat-w"),
    );
    expect(observe.isError).toBe(true);
    expect(observe.text).toContain("observe mode");

    const bearer = await coordinatorOf("auto");
    const outside = await callTool(bearer, "worktrees_create", base("feat-x", { repo: "ghost" }));
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('Repo "ghost" is not in project');
    const taken = await callTool(bearer, "worktrees_create", base("feat-search"));
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("already exists");
    const both = await callTool(bearer, "worktrees_create", {
      ...base("feat-both"),
      group: { repos: [{ repo: "api" }, { repo: "client" }], mode: "split" },
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("exactly one of repo or group");
  }, 90_000);
});

describe("a split group of two repos (S4)", () => {
  let bearer: string;

  beforeAll(async () => {
    await createProject("duo", { autonomy: "autonomous", labels: ["zone=home"] });
    bearer = await coordinatorOf("duo");
  }, 60_000);

  it("creates a worktree per repo with sibling info and the PR order in each brief, and a task group", async () => {
    const res = await callTool(bearer, "worktrees_create", {
      group: {
        repos: [
          { repo: "api", role: "backend" },
          { repo: "client", role: "frontend" },
        ],
        mode: "split",
        mergeOrder: ["api", "client"],
      },
      branch: "feat-checkout",
      title: "Checkout flow",
      brief: "Add the checkout flow.\n",
      scenarios: ["checkout completes"],
    });
    expect(res.isError, res.text).toBe(false);
    const body = res.json() as { groupId: string; worktrees: Array<{ worktreeId: string }> };
    expect(body.groupId).toMatch(/^tg-/);
    expect(body.worktrees.map((w) => w.worktreeId)).toEqual([
      "api-feat-checkout",
      "client-feat-checkout",
    ]);

    const apiBrief = readFileSync(briefOf("api", "feat-checkout"), "utf8");
    const clientBrief = readFileSync(briefOf("client", "feat-checkout"), "utf8");
    expect(apiBrief).toContain("Repo: api");
    expect(apiBrief).toContain("- client (frontend): worktree `client-feat-checkout`");
    expect(clientBrief).toContain("Repo: client");
    expect(clientBrief).toContain("- api (backend): worktree `api-feat-checkout`");
    for (const text of [apiBrief, clientBrief]) {
      expect(text).toContain("Pull request order: 1. api, 2. client");
      expect(text).toContain("- S1: checkout completes");
    }

    const { groups } = await q<{ groups: Group[] }>("projects.groups", { project: "duo" });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: body.groupId,
      branch: "feat-checkout",
      mode: "split",
      mergeOrder: ["api", "client"],
    });
    expect(groups[0].members.map((x) => [x.repo, x.worktreeId, x.hostId])).toEqual([
      ["api", "api-feat-checkout", workerHostId],
      ["client", "client-feat-checkout", workerHostId],
    ]);
  });

  it("refuses mode combined until the multi-repo root exists", async () => {
    const res = await callTool(bearer, "worktrees_create", {
      group: { repos: [{ repo: "api" }, { repo: "client" }], mode: "combined" },
      branch: "feat-combined",
      brief: "x",
      scenarios: [],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("combined");
    expect(await worktreeExists("api-feat-combined")).toBe(false);
  });

  it("rejects a merge order that does not list every repo once", async () => {
    const res = await callTool(bearer, "worktrees_create", {
      group: {
        repos: [{ repo: "api" }, { repo: "client" }],
        mode: "split",
        mergeOrder: ["api"],
      },
      branch: "feat-order",
      brief: "x",
      scenarios: [],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("mergeOrder");
  });
});
