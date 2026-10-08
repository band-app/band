// Integration tests for dispatch from a project coordinator: the `worktree_create` tool of
// `/mcp-proxy/band-coordinator` (V3 of the projects redesign). A real hub (production bundle, random
// port, auth on), real git repos and a real `band-worker` process that carries the label the projects
// ask for. The coding agent is the scripted ACP stub on the hub and on the worker. The coordinator's
// tool is called over HTTP with the `mcp_` token the hub gave its session, exactly as the agent would.

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
import { DatabaseSync } from "node:sqlite";
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
import { stubClaudeDir, stubClaudeEnv } from "./helpers/stub-agent-cli";
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

interface ProjectView {
  id: string;
  name: string;
}
interface WorktreeRow {
  name: string;
  path: string;
  hostId?: string;
  projectId?: string;
}

const createProject = (name: string, policy: Record<string, unknown>, repos = ["api"]) =>
  m<{ project: ProjectView }>("projects.create", {
    name,
    repos: repos.map((repo) => ({ repo })),
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

const workerLog = () =>
  existsSync(workerStubLog)
    ? completeLines(readFileSync(workerStubLog, "utf8")).map(
        (l) => JSON.parse(l) as { method: string; params: Record<string, unknown> },
      )
    : [];

const worktreeRow = async (repo: string, name: string): Promise<WorktreeRow | undefined> => {
  const { repos } = await q<{ repos: Array<{ name: string; worktrees: WorktreeRow[] }> }>(
    "repos.list",
  );
  return repos.find((r) => r.name === repo)?.worktrees.find((w) => w.name === name);
};

const seedSpend = (worktreeId: string, repo: string, costUsd: number) => {
  const db = new DatabaseSync(join(home, ".band", "band.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      `INSERT INTO usage_events (task_id, session_id, worktree_id, repo, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, reasoning_output_tokens, cost_usd, captured_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
    ).run(`t-${worktreeId}`, `s-${worktreeId}`, worktreeId, repo, costUsd, Date.now());
  } finally {
    db.close();
  }
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
        // The worker reports claude installed and logged in, which placement requires for the agent.
        ...stubClaudeEnv(stubClaudeDir()),
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

describe("an autonomous coordinator dispatches (V3)", () => {
  const brief = "# Add the search endpoint\nGoal: GET /search returns matches.\n";
  let bearer: string;
  let project: ProjectView;

  beforeAll(async () => {
    project = await createProject(
      "auto",
      { autonomy: "autonomous", labels: ["zone=home"], models: { worker: "haiku" } },
      ["api", "client"],
    );
    bearer = await coordinatorOf("auto");
  }, 60_000);

  it("creates one worktree of the repo on the matching host, attached to the project, with the brief and a started chat on the worker model", async () => {
    const res = await callTool(bearer, "worktree_create", {
      repo: "api",
      branch: "feat-search",
      title: "Search endpoint",
      brief,
      scenarios: ["GET /search?q=a returns 200", "an empty query returns 400"],
      placement: { labels: { zone: "home" } },
    });
    expect(res.isError, res.text).toBe(false);
    const body = res.json() as {
      status: string;
      repo: string;
      branch: string;
      worktreeId: string;
      chatId: string;
      path: string;
    };
    expect(body).toMatchObject({
      status: "dispatched",
      repo: "api",
      branch: "feat-search",
      worktreeId: "api-feat-search",
    });
    expect(body.chatId).toEqual(expect.any(String));

    const worktree = await worktreeRow("api", "feat-search");
    expect(worktree?.hostId).toBe(workerHostId);
    expect(worktree?.projectId).toBe(project.id);
    expect(worktree?.path).toBe(body.path);
    expect(realpathSync(body.path)).toBe(
      realpathSync(join(workerRoot, ".band-worktrees", "api", "feat-search")),
    );
    // Only the named repo got a worktree.
    expect(await worktreeRow("client", "feat-search")).toBeUndefined();

    const text = readFileSync(join(body.path, ".am", "BRIEF.md"), "utf8");
    expect(text).toContain("## Task: Search endpoint");
    expect(text).toContain("Project: auto\nRepo: api\nBranch: feat-search");
    expect(text).toContain("Goal: GET /search returns matches.");
    expect(text).toContain("- S1: GET /search?q=a returns 200");
    expect(text).toContain("- S2: an empty query returns 400");
    // `.am/` is excluded, so the brief is no change in the repository.
    expect(git(body.path, "status", "--porcelain")).toBe("");
    expect(git(body.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat-search");

    const { chats } = await q<{ chats: Array<{ id: string; agent: string; model: string }> }>(
      "chats.list",
      { worktreeId: "api-feat-search" },
    );
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ id: body.chatId, agent: "claude-code", model: "haiku" });

    // The agent starts on the worker, in the worktree, with a prompt that points at the brief.
    const started = await waitFor(
      () =>
        workerLog().find(
          (r) =>
            r.method === "session/new" &&
            typeof r.params.cwd === "string" &&
            r.params.cwd.endsWith("/api/feat-search"),
        ),
      { label: "session/new in the worktree", timeoutMs: 30_000 },
    );
    expect(realpathSync(started.params.cwd as string)).toBe(realpathSync(body.path));
    const prompt = await waitFor(
      () =>
        workerLog()
          .filter((r) => r.method === "session/prompt")
          .map((r) => JSON.stringify(r.params))
          .find((p) => p.includes(".am/BRIEF.md")),
      { label: "worker prompt that points at the brief", timeoutMs: 30_000 },
    );
    expect(prompt).toContain("source of truth");
  });

  it("lists the dispatched worktree for the coordinator and on the project", async () => {
    const list = await callTool(bearer, "worktrees_list");
    expect(list.isError, list.text).toBe(false);
    expect(list.text).toContain("api-feat-search");
    const { project: detail } = await q<{
      project: { worktrees: Array<{ worktreeId: string }> };
    }>("projects.get", { project: "auto" });
    expect(detail.worktrees.map((w) => w.worktreeId)).toEqual(["api-feat-search"]);
  });

  it("takes one call per repo for work in two repos", async () => {
    const res = await callTool(bearer, "worktree_create", {
      repo: "client",
      branch: "feat-search",
      brief: "Call GET /search from the search box.",
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.json()).toMatchObject({ status: "dispatched", worktreeId: "client-feat-search" });
    expect((await worktreeRow("client", "feat-search"))?.projectId).toBe(project.id);
  }, 60_000);

  it("refuses a call that names several repos or misses the brief", async () => {
    const several = await callTool(bearer, "worktree_create", {
      repos: [{ repo: "api" }],
      branch: "feat-old",
      brief: "x",
    });
    expect(several.isError).toBe(true);
    expect(several.text).toContain("Invalid arguments for tool worktree_create");
    expect(several.text).toContain('"repo"');
    const noBrief = await callTool(bearer, "worktree_create", { repo: "api", branch: "feat-nb" });
    expect(noBrief.isError).toBe(true);
    expect(noBrief.text).toContain("Invalid arguments for tool worktree_create");
    expect(noBrief.text).toContain('"brief"');
    expect(await worktreeRow("api", "feat-old")).toBeUndefined();
    expect(await worktreeRow("api", "feat-nb")).toBeUndefined();
  });
});

describe("a stored steer policy dispatches at once", () => {
  it("reads steer as autonomous, leaves auto-merge off and creates the worktree without an approval", async () => {
    await createProject("steer", { autonomy: "steer", autoMerge: true, labels: ["zone=home"] }, [
      "client",
    ]);
    const { project } = await q<{
      project: { id: string; effectivePolicy: { autonomy: string; autoMerge: boolean } };
    }>("projects.get", { project: "steer" });
    expect(project.effectivePolicy.autonomy).toBe("autonomous");
    expect(project.effectivePolicy.autoMerge).toBe(false);
    const bearer = await coordinatorOf("steer");
    const res = await callTool(bearer, "worktree_create", {
      repo: "client",
      branch: "feat-now",
      brief: "Do feat-now",
      scenarios: ["it works"],
    });
    expect(res.isError, res.text).toBe(false);
    const created = await worktreeRow("client", "feat-now");
    expect(created?.projectId).toBe(project.id);
    expect(existsSync(join(created?.path ?? "", ".am", "BRIEF.md"))).toBe(true);
  }, 60_000);
});

describe("the policy refuses a dispatch", () => {
  const base = (branch: string, extra: Record<string, unknown> = {}) => ({
    repo: "api",
    branch,
    brief: "x",
    ...extra,
  });

  it("refuses isolation below the floor", async () => {
    await createProject("floor", { autonomy: "autonomous", isolationFloor: "container" });
    const bearer = await coordinatorOf("floor");
    const res = await callTool(
      bearer,
      "worktree_create",
      base("feat-floor", { placement: { isolation: "worktree" } }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("isolation worktree is below the floor");
    expect(res.text).toContain("container");
    expect(await worktreeRow("api", "feat-floor")).toBeUndefined();
  });

  it("refuses labels outside the project's", async () => {
    await createProject("labels", { autonomy: "autonomous", labels: ["zone=home"] });
    const bearer = await coordinatorOf("labels");
    const res = await callTool(
      bearer,
      "worktree_create",
      base("feat-cloud", { placement: { labels: { zone: "cloud" } } }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("zone=cloud is not among the labels");
    expect(await worktreeRow("api", "feat-cloud")).toBeUndefined();
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
    const refused = await callTool(bearer, "worktree_create", base("feat-over"));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("1 worker agents are already running");
    expect(refused.text).toContain("allows 1 at once");
    expect(await worktreeRow("api", "feat-over")).toBeUndefined();
    await callTool(bearer, "worktree_stop", { worktreeId: "api-busy" });
  }, 90_000);

  it("refuses a dispatch once the project has spent its budget", async () => {
    await createProject("spent", { autonomy: "autonomous", budgetUsd: 1 });
    const bearer = await coordinatorOf("spent");
    await m("worktrees.create", { repo: "api", branch: "spender", projectId: "spent" });
    seedSpend("api-spender", "api", 2);
    const refused = await callTool(bearer, "worktree_create", base("feat-broke"));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('project "spent" has spent $2.00 of its $1 budget');
    expect(await worktreeRow("api", "feat-broke")).toBeUndefined();
  }, 60_000);

  it("refuses in observe mode, a repo outside the project and a taken branch", async () => {
    await createProject("watch", { autonomy: "observe" });
    const observe = await callTool(await coordinatorOf("watch"), "worktree_create", base("feat-w"));
    expect(observe.isError).toBe(true);
    expect(observe.text).toContain("observe mode");
    expect(await worktreeRow("api", "feat-w")).toBeUndefined();

    // The checks below need an autonomous project and a branch that is already taken, so they
    // make their own and do not depend on what the other tests dispatched.
    await createProject("strict", { autonomy: "autonomous" });
    const bearer = await coordinatorOf("strict");
    await m("worktrees.create", { repo: "api", branch: "feat-taken" });
    const outside = await callTool(bearer, "worktree_create", base("feat-x", { repo: "client" }));
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('Repo "client" is not in project "strict"');
    expect(await worktreeRow("client", "feat-x")).toBeUndefined();
    const ghost = await callTool(bearer, "worktree_create", base("feat-x", { repo: "ghost" }));
    expect(ghost.isError).toBe(true);
    expect(ghost.text).toContain('"ghost"');
    const taken = await callTool(bearer, "worktree_create", base("feat-taken"));
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("Worktree api-feat-taken already exists");
    // The taken worktree stays outside the project.
    expect((await worktreeRow("api", "feat-taken"))?.projectId).toBeUndefined();
  }, 90_000);
});
