// Integration test for a project's coordinator on a hub with BAND_LOCAL_HOST=off (S1 to S4, S11).
// The hub runs with its own machine turned off, so every host is a real `band-worker` process. The
// worker's `claude` is a stub CLI (found through BAND_AGENT_BIN_DIRS) that reports a login, and the
// coding agents are the scripted ACP stub. The coordinator's agent calls the band-coordinator tools
// through the exact URL and headers Band gave it, so the call travels the worker's relay and the link.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeLines,
  STUB_AGENT_PATH,
  type StubRequest,
  TEST_TOKEN,
  writeStubScenario,
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
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" }).trim();

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

let home: string;
let server: ServerHandle;
const workers: ChildProcess[] = [];
let workerRoot: string;
let httpLog: string;

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

interface Worker {
  hostId: string;
  home: string;
  stubLog: string;
}

async function startWorker(name: string, binDir: string): Promise<Worker> {
  const workerHome = tmp("band-cow-whome-");
  const stubLog = join(workerHome, "stub-log.jsonl");
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
  });
  const child = spawn(
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
      tmp("band-cow-state-"),
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        ...stubClaudeEnv(binDir),
        BAND_PROJECT_FETCH_THROTTLE_MS: "0",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_LOG: stubLog,
        BAND_TEST_ACP_SCENARIO: join(home, "acp-scenario.json"),
        BAND_TEST_ACP_HTTP_LOG: httpLog,
      },
      stdio: "ignore",
    },
  );
  workers.push(child);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `worker ${name} online`, timeoutMs: 20_000 },
  );
  return { hostId: issued.hostId, home: workerHome, stubLog };
}

const requestsOf = (w: Worker, method: string): StubRequest[] =>
  existsSync(w.stubLog)
    ? completeLines(readFileSync(w.stubLog, "utf8"))
        .map((l) => JSON.parse(l) as StubRequest)
        .filter((r) => r.method === method)
    : [];

const httpLines = () =>
  existsSync(httpLog)
    ? completeLines(readFileSync(httpLog, "utf8")).map(
        (l) => JSON.parse(l) as { name: string; status: number; body: string },
      )
    : [];

const remoteOf = (name: string) => join(workerRoot, "remotes", `${name}.git`);

function seedRemoteRepo(name: string): void {
  git(workerRoot, "init", "-q", "--bare", "-b", "main", remoteOf(name));
  const seed = join(tmp("band-cow-seed-"), name);
  git(workerRoot, "clone", "-q", remoteOf(name), seed);
  git(seed, "checkout", "-q", "-B", "main");
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "-u", "origin", "main");
}

beforeAll(async () => {
  home = createTmpHome("band-cow-");
  workerRoot = tmp("band-cow-root-");
  httpLog = join(home, "http-log.jsonl");
  for (const name of ["api", "client"]) seedRemoteRepo(name);
  seedState(home, { repos: [] });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  writeStubScenario(home, [
    {
      match: "DISPATCH-NOW",
      steps: [
        { mcpCall: { name: "list", server: "band-coordinator", tool: "", method: "tools/list" } },
        {
          mcpCall: {
            name: "dispatch",
            server: "band-coordinator",
            tool: "worktree_create",
            args: {
              repo: "api",
              branch: "feat-one",
              title: "One",
              brief: "Do the thing",
              scenarios: [],
            },
          },
        },
        { say: "dispatched" },
      ],
    },
    { steps: [{ say: "ok" }] },
  ]);
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_LOCAL_HOST: "off",
      BAND_PROJECT_FETCH_THROTTLE_MS: "0",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
    },
  });
  for (const name of ["api", "client"]) {
    await m("repos.addByUrl", { remoteUrl: remoteOf(name), defaultBranch: "main", name });
  }
}, 180_000);

afterAll(async () => {
  for (const w of workers) w.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

interface ProjectView {
  id: string;
  coordinatorHostId: string | null;
  coordinatorWaiting: boolean;
  coordinatorError: string | null;
  coordinator: { chatId: string; hostId: string | null } | null;
}

let alpha: Worker;
let projectId: string;

describe("with no capable worker online (S3)", () => {
  it("shows the waiting state and places nothing on the hub", async () => {
    const created = await m<{ project: ProjectView }>("projects.create", {
      name: "shop",
      repos: [{ repo: "api" }, { repo: "client" }],
    });
    projectId = created.project.id;
    const shown = await waitFor(
      async () => {
        const { project } = await q<{ project: ProjectView }>("projects.get", { project: "shop" });
        return project.coordinatorWaiting ? project : undefined;
      },
      { label: "waiting state", timeoutMs: 20_000 },
    );
    expect(shown.coordinatorError).toBe("Waiting for a worker that can run claude-code");
    expect(shown.coordinatorHostId).toBeNull();
    // Nothing was placed on the hub's own machine.
    expect(existsSync(join(home, ".band", "projects", "shop"))).toBe(false);
  });

  it("does not place it on a worker whose claude is not logged in", async () => {
    const loggedOut = await startWorker("Logged out", stubClaudeDir(false));
    // Wait until the hub holds the worker's report, so the check below is not just early.
    await waitFor(
      async () => {
        const { hosts } = await q<{
          hosts: Array<{
            id: string;
            report: { agents: Array<{ type: string; loggedIn: boolean | null }> } | null;
          }>;
        }>("hosts.list");
        const claude = hosts
          .find((h) => h.id === loggedOut.hostId)
          ?.report?.agents.find((a) => a.type === "claude-code");
        return claude && claude.loggedIn === false ? true : undefined;
      },
      { label: "report of the logged-out worker", timeoutMs: 30_000 },
    );
    const { project } = await q<{ project: ProjectView }>("projects.get", { project: "shop" });
    expect(project.coordinatorWaiting).toBe(true);
    expect(project.coordinatorHostId).toBeNull();
  });
});

describe("with a capable worker (S1, S2, S11)", () => {
  it("places the coordinator and the project folder on that worker, not the hub (S1)", async () => {
    alpha = await startWorker("Alpha", stubClaudeDir(true));
    const placed = await waitFor(
      async () => {
        const { project } = await q<{ project: ProjectView }>("projects.get", { project: "shop" });
        return project.coordinatorHostId === alpha.hostId ? project : undefined;
      },
      { label: "coordinator placed", timeoutMs: 30_000 },
    );
    expect(placed.coordinatorWaiting).toBe(false);
    const folder = join(alpha.home, ".band", "projects", "shop");
    const session = await waitFor(
      () => requestsOf(alpha, "session/new").find((r) => r.cwd === folder),
      {
        label: "session/new on the worker",
        timeoutMs: 60_000,
      },
    );
    expect(session.env.BAND_PROJECT_ID).toBe(projectId);
    expect(existsSync(join(home, ".band", "projects", "shop"))).toBe(false);
    const { hosts } = await q<{
      hosts: Array<{
        id: string;
        report: { agents: Array<{ type: string; loggedIn: boolean | null }> } | null;
      }>;
    }>("hosts.list");
    const reported = hosts
      .find((h) => h.id === alpha.hostId)
      ?.report?.agents.find((a) => a.type === "claude-code");
    expect(reported?.loggedIn).toBe(true);
  });

  it("keeps the checkouts out of the worker's own clone (S11)", async () => {
    const folder = join(alpha.home, ".band", "projects", "shop");
    const checkout = join(folder, "repos", "api");
    await waitFor(() => (existsSync(join(checkout, "README.md")) ? true : undefined), {
      label: "api checkout",
      timeoutMs: 60_000,
    });
    // An independent clone: a `.git` directory, on the default branch.
    expect(statDir(join(checkout, ".git"))).toBe(true);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(checkout, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
    const source = join(alpha.home, "band", "repos");
    const clones = execFileSync("find", [source, "-maxdepth", "4", "-name", ".git"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(clones.length).toBeGreaterThan(0);
    for (const dotGit of clones) {
      const clone = dotGit.replace(/\/\.git$/, "");
      expect(git(clone, "worktree", "list", "--porcelain")).not.toContain("projects/shop");
      expect(git(clone, "branch", "--list")).not.toContain("band/shop");
    }
  });

  it("lists the band-coordinator tools and a worktree_create call creates a worktree through the relay (S2)", async () => {
    const { project } = await q<{ project: ProjectView }>("projects.get", { project: "shop" });
    const chatId = project.coordinator?.chatId as string;
    await m("chats.send", { worktreeId: `project:${projectId}`, chatId, message: "DISPATCH-NOW" });
    const lines = await waitFor(
      () => {
        const l = httpLines();
        return l.some((x) => x.name === "dispatch") ? l : undefined;
      },
      { label: "tool calls", timeoutMs: 60_000 },
    );
    const list = lines.find((l) => l.name === "list");
    expect(list?.status).toBe(200);
    expect(list?.body).toContain("worktree_create");
    expect(list?.body).toContain("project_status");
    const dispatch = lines.find((l) => l.name === "dispatch");
    expect(dispatch?.status).toBe(200);
    expect(dispatch?.body).not.toContain('"isError":true');
    const made = await waitFor(
      async () => {
        const { repos } = await q<{
          repos: Array<{
            name: string;
            worktrees: Array<{ branch: string; hostId?: string | null }>;
          }>;
        }>("repos.list");
        return repos.find((r) => r.name === "api")?.worktrees.find((w) => w.branch === "feat-one");
      },
      { label: "dispatched worktree", timeoutMs: 60_000 },
    );
    expect(made.hostId).toBe(alpha.hostId);
  });
});

describe("moving the coordinator (S4)", () => {
  let beta: Worker;

  it("is refused while the old checkout has uncommitted changes, and says why", async () => {
    beta = await startWorker("Beta", stubClaudeDir(true));
    const checkout = join(alpha.home, ".band", "projects", "shop", "repos", "client");
    writeFileSync(join(checkout, "wip.txt"), "not committed\n");
    const res = await trpcMutate(
      server.url,
      "projects.update",
      { project: "shop", coordinatorHostId: beta.hostId },
      TEST_TOKEN,
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("client has uncommitted changes");
    const { project } = await q<{ project: ProjectView }>("projects.get", { project: "shop" });
    expect(project.coordinatorHostId).toBe(alpha.hostId);
    rmSync(join(checkout, "wip.txt"));
  });

  it("moves the folder and resumes the coordinator chat on the new host", async () => {
    await m("projects.update", { project: "shop", coordinatorHostId: beta.hostId });
    const folder = join(beta.home, ".band", "projects", "shop");
    await waitFor(() => requestsOf(beta, "session/new").find((r) => r.cwd === folder), {
      label: "session/new on the new worker",
      timeoutMs: 60_000,
    });
    expect(existsSync(join(folder, "repos", "api", "README.md"))).toBe(true);
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
    // The tools still work from the new host: the token of the old process was not revoked by its exit.
    const { project } = await q<{ project: ProjectView }>("projects.get", { project: "shop" });
    const before = httpLines().length;
    await m("chats.send", {
      worktreeId: `project:${projectId}`,
      chatId: project.coordinator?.chatId,
      message: "DISPATCH-NOW",
    });
    const lines = await waitFor(
      () => {
        const l = httpLines();
        return l.length >= before + 2 ? l : undefined;
      },
      { label: "tool calls on the new host", timeoutMs: 60_000 },
    );
    expect(lines.slice(before).find((l) => l.name === "list")?.status).toBe(200);
  });
});

function statDir(path: string): boolean {
  try {
    return execFileSync("test", ["-d", path]) !== null;
  } catch {
    return false;
  }
}
