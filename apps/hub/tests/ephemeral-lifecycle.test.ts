// Integration tests for the ephemeral worker lifecycle (plan step 3.5). A real hub (the production
// bundle on a random port, temp BAND_HOME) runs the bundled `local` runner hook, which starts the
// real `band-worker --ephemeral`. The coding agent is the scripted ACP stub. Each worker is a new
// "machine": the hook wipes the worker's directory when it starts, and the tests clear the stub's
// session store while the worker is gone, so only what the hub saved can come back.
//
// The idle time is short on purpose: `BAND_EPHEMERAL_IDLE_TIMEOUT_MS` (the hub tells the worker)
// and `BAND_AGENT_IDLE_TIMEOUT_MS` (the hub stops an idle agent process, which closes the
// worker's channel).

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
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
import { maxId, openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

// The chat stream helpers authenticate with this token.
const TOKEN = TEST_TOKEN;
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const IDLE_MS = 2500;

interface Workspace {
  name: string;
  path: string;
  hostId?: string;
  lifecycle?: "sleeping" | "waking";
}
interface ProjectsList {
  projects: Array<{ name: string; worktrees: Workspace[] }>;
}
interface HostsList {
  hosts: Array<{ id: string; status: string; sleepError: string | null }>;
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** A bare origin and the hub's checkout of it, with one commit on main. */
function makeProject(base: string, name: string): { origin: string; checkout: string } {
  const origin = join(base, `${name}-origin.git`);
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  const checkout = join(base, name);
  git(base, "clone", "-q", origin, checkout);
  git(checkout, "checkout", "-q", "-b", "main");
  writeFileSync(join(checkout, "hello.txt"), "hello\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "init");
  git(checkout, "push", "-q", "origin", "main");
  return { origin, checkout };
}

let server: ServerHandle;
let hubHome: string;
let stubState: string;
let stubLog: string;
let a: { origin: string; checkout: string };
let b: { origin: string; checkout: string };

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

const workspace = async (project: string, name: string) =>
  (await q<ProjectsList>("projects.list")).projects
    .find((p) => p.name === project)
    ?.worktrees.find((w) => w.name === name);
const host = async (id: string) =>
  (await q<HostsList>("hosts.list")).hosts.find((h) => h.id === id);
const sleeping = (project: string, name: string) =>
  waitFor(
    async () => ((await workspace(project, name))?.lifecycle === "sleeping" ? true : undefined),
    { label: `${project}-${name} sleeps`, timeoutMs: 90_000, intervalMs: 250 },
  ).catch((err) => {
    // Say what the workers said, so a failure explains itself.
    const base = join(hubHome, ".band", "runners", "eph");
    const logs = existsSync(base)
      ? readdirSync(base).map((id) => `--- ${id}\n${workerLog(id)}`)
      : [];
    throw new Error(`${err.message}\n${logs.join("\n")}`);
  });

/** `<runner dir>/<host id>/` holds the worker's pid and log. */
const runnerDir = (hostId: string) => join(hubHome, ".band", "runners", "eph", hostId);
const workerLog = (hostId: string) => {
  const file = join(runnerDir(hostId), "worker.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidOf = (hostId: string) => Number(readFileSync(join(runnerDir(hostId), "pid"), "utf8"));

async function createWorkspace(project: string, branch: string): Promise<Workspace> {
  await m("workspaces.create", { project, branch, placement: { labels: { pool: "eph" } } });
  return waitFor(
    async () => {
      const wt = await workspace(project, branch);
      return wt?.hostId ? wt : undefined;
    },
    { label: `${project}-${branch} on a worker`, timeoutMs: 90_000, intervalMs: 250 },
  );
}

async function turn(workspaceId: string, chatId: string, text: string, after = 0) {
  const stream = await openStream(server.url, chatId, {
    lastEventId: after,
    until: (e) => turnEnded(e) && (e.eventId > after || e.eventId < 0),
    timeoutMs: 120_000,
  });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ workspaceId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return stream.events;
}

const stubRequests = (method: string) =>
  existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) => JSON.parse(l) as { method: string; params: { sessionId?: string }; pid: number },
        )
        .filter((r) => r.method === method)
    : [];

beforeAll(async () => {
  hubHome = createTmpHome("band-ephemeral-hub-");
  scratch.push(hubHome);
  const base = tmp("band-ephemeral-repos-");
  a = makeProject(base, "proja");
  b = makeProject(base, "projb");
  // projb's origin refuses every push after the setup, as a remote the worker cannot write to.
  const hook = join(b.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'read-only remote' >&2\nexit 1\n");
  chmodSync(hook, 0o755);

  stubState = tmp("band-ephemeral-stub-state-");
  stubLog = join(tmp("band-ephemeral-stub-log-"), "stub-log.jsonl");
  const scenario = join(tmp("band-ephemeral-scenario-"), "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [{ match: "^slow", steps: [{ say: "working" }, { sleep: 9000 }, { say: "done" }] }],
    }),
  );
  seedSettings(hubHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    projects: [a, b].map((p, i) => ({
      name: i === 0 ? "proja" : "projb",
      path: p.checkout,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: p.checkout }],
    })),
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_EPHEMERAL_IDLE_TIMEOUT_MS: String(IDLE_MS),
      BAND_AGENT_IDLE_TIMEOUT_MS: "1500",
    },
  });
  await m("settings.update", {
    runners: [
      {
        id: "eph",
        spawn: "bundled:local",
        destroy: "bundled:local",
        labels: { pool: "eph" },
        isolation: "process",
        maxConcurrent: 2,
        timeoutSec: 90,
        env: {
          BAND_WORKER_BIN: WORKER_BIN,
          BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
          BAND_TEST_ACP_STATE: stubState,
          BAND_TEST_ACP_LOG: stubLog,
          BAND_TEST_ACP_SCENARIO: scenario,
          BAND_AGENT_SESSION_DIRS: stubState,
        },
      },
    ],
  });
}, 120_000);

afterAll(async () => {
  const base = join(hubHome ?? "", ".band", "runners", "eph");
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      try {
        process.kill(Number(readFileSync(join(base, dir, "pid"), "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("sleep and wake", () => {
  let hostId = "";
  let worktree = "";
  let chatId = "";
  let sessionFile = "";
  let seen = 0;

  it("stores a workspace with an uncommitted edit and lets the idle worker exit (S1)", async () => {
    const wt = await createWorkspace("proja", "eph-a");
    hostId = wt.hostId as string;
    worktree = wt.path;
    expect((await host(hostId))?.status).toBe("online");

    // Work the hub cannot see in git: a modified tracked file and a new untracked one.
    appendFileSync(join(worktree, "hello.txt"), "edited on the worker\n");
    mkdirSync(join(worktree, "notes"));
    writeFileSync(join(worktree, "notes", "scratch.txt"), "scratch\n");

    chatId = "eph-chat";
    const first = await turn("proja-eph-a", chatId, "remember: banana");
    seen = maxId(first);
    const sessions = readdirSync(stubState).filter((f) => f.endsWith(".json"));
    expect(sessions).toHaveLength(1);
    sessionFile = sessions[0] as string;

    // The worker belongs to this workspace: placement does not give it to another one.
    // (It may go idle while the second worker starts, which is the sleep checked next.)
    const other = await createWorkspace("proja", "eph-other");
    expect(other.hostId).not.toBe(hostId);

    const pid = pidOf(hostId);
    await sleeping("proja", "eph-a");

    expect(await host(hostId)).toMatchObject({ status: "offline", sleepError: null });
    await waitFor(async () => !isAlive(pid), { label: "worker process exits", timeoutMs: 20_000 });
    expect(workerLog(hostId)).toContain("the hub stored the workspaces, exiting");
    // Origin holds the working tree, on top of the branch head.
    const ref = "refs/heads/band/wip/proja-eph-a";
    expect(git(a.origin, "show", `${ref}:hello.txt`)).toContain("edited on the worker");
    expect(git(a.origin, "show", `${ref}:notes/scratch.txt`)).toBe("scratch\n");
    // The hub holds the agent session.
    expect(existsSync(join(hubHome, ".band", "sleep", "proja-eph-a", "sessions.json"))).toBe(true);
  }, 180_000);

  it("wakes on a chat message with the edit present and the conversation resumed (S2)", async () => {
    // The old machine is gone: only what the hub saved can bring the session back.
    for (const f of readdirSync(stubState)) rmSync(join(stubState, f), { recursive: true });
    const sessionsStarted = stubRequests("session/new").length;

    const events = await turn("proja-eph-a", chatId, "what was it?", seen);
    expect(events.some((e) => e.type === "turn-ended")).toBe(true);
    seen = maxId(events);

    const wt = await workspace("proja", "eph-a");
    expect(wt?.lifecycle).toBeUndefined();
    expect(wt?.hostId).toBe(hostId);
    expect((await host(hostId))?.status).toBe("online");
    expect(readFileSync(join(wt?.path ?? "", "hello.txt"), "utf8")).toBe(
      "hello\nedited on the worker\n",
    );
    expect(readFileSync(join(wt?.path ?? "", "notes", "scratch.txt"), "utf8")).toBe("scratch\n");
    // Uncommitted again, as it was, and the branch has no snapshot commit.
    expect(git(wt?.path ?? "", "status", "--porcelain")).toMatch(/^ M hello\.txt$/m);
    expect(git(wt?.path ?? "", "status", "--porcelain")).toMatch(/^\?\? notes\/$/m);
    expect(git(wt?.path ?? "", "log", "--format=%s")).toBe("init\n");

    // The agent resumed the session it had before, and did not start a new one.
    const resumed = [...stubRequests("session/resume"), ...stubRequests("session/load")];
    expect(resumed.map((r) => r.params.sessionId)).toContain(sessionFile.replace(/\.json$/, ""));
    expect(stubRequests("session/new")).toHaveLength(sessionsStarted);
    expect(readdirSync(stubState)).toContain(sessionFile);
    // The snapshot branch is cleaned up on origin, and the hub dropped its copy.
    expect(git(a.origin, "branch", "--list", "band/wip/proja-eph-a").trim()).toBe("");
    expect(existsSync(join(hubHome, ".band", "sleep", "proja-eph-a"))).toBe(false);
    worktree = wt?.path ?? worktree;
  }, 180_000);

  it("keeps the worker while a terminal runs, and sleeps after it is closed (S3)", async () => {
    const terminalId = "11111111-1111-4111-8111-111111111111";
    await m("terminal.create", { workspaceId: "proja-eph-a", id: terminalId });
    // Longer than two idle times: the worker asks, and the hub says no.
    await waitFor(
      async () => (workerLog(hostId).includes("a terminal is running") ? true : undefined),
      {
        label: "hub refuses while a terminal runs",
        timeoutMs: IDLE_MS * 6,
        intervalMs: 250,
      },
    );
    expect((await host(hostId))?.status).toBe("online");
    expect((await workspace("proja", "eph-a"))?.lifecycle).toBeUndefined();

    await m("terminal.kill", { terminalId });
    await sleeping("proja", "eph-a");
  }, 180_000);

  it("keeps the worker for the length of a running turn (S3)", async () => {
    const started = Date.now();
    const turnDone = turn("proja-eph-a", chatId, "slow please", seen);
    // Wakes on the message, then the 9 s turn outlasts two idle times.
    await waitFor(
      async () => {
        const wt = await workspace("proja", "eph-a");
        return wt && wt.lifecycle === undefined && (await host(hostId))?.status === "online"
          ? true
          : undefined;
      },
      { label: "woken for the turn", timeoutMs: 90_000, intervalMs: 250 },
    );
    const events = await turnDone;
    expect(Date.now() - started).toBeGreaterThan(8000);
    expect(events.some((e) => e.type === "turn-ended")).toBe(true);
    // While the turn ran, nothing had put it to sleep (the turn only ended now).
    expect(workerLog(hostId)).not.toContain("the hub stored the workspaces, exiting");
    await sleeping("proja", "eph-a");
  }, 240_000);

  it("wakes on a file read too", async () => {
    const file = await q<{ content: string }>("workspace.getFile", {
      workspaceId: "proja-eph-a",
      path: "hello.txt",
    });
    expect(file.content).toBe("hello\nedited on the worker\n");
    expect((await workspace("proja", "eph-a"))?.lifecycle).toBeUndefined();
  }, 180_000);
});

describe("persist failure", () => {
  it("keeps the worker alive and says why when nothing can store the work (S4)", async () => {
    const wt = await createWorkspace("projb", "eph-b");
    const hostId = wt.hostId as string;
    appendFileSync(join(wt.path, "hello.txt"), "do not lose me\n");

    // projb's origin rejects pushes, and the hub's sleep directory cannot be made.
    const sleepPath = join(hubHome, ".band", "sleep");
    rmSync(sleepPath, { recursive: true, force: true });
    writeFileSync(sleepPath, "a file where the directory should be");

    const failed = await waitFor(
      async () => {
        const h = await host(hostId);
        return h?.sleepError ? h : undefined;
      },
      { label: "persist failure reported", timeoutMs: 60_000, intervalMs: 250 },
    );
    expect(failed.sleepError).toContain("no writable remote");
    expect(failed.status).toBe("online");
    expect((await workspace("projb", "eph-b"))?.lifecycle).toBeUndefined();
    expect(readFileSync(join(wt.path, "hello.txt"), "utf8")).toContain("do not lose me");
    expect(workerLog(hostId)).not.toContain("exiting");
    expect(git(b.origin, "branch", "--list", "band/wip/*").trim()).toBe("");

    // Once the hub can keep the snapshot, the next idle question succeeds.
    rmSync(sleepPath);
    await sleeping("projb", "eph-b");
    expect((await host(hostId))?.sleepError).toBeNull();
    expect(existsSync(join(sleepPath, "projb-eph-b", "snapshot.bundle"))).toBe(true);

    // The bundle brings the edit back on a new worker.
    const file = await q<{ content: string }>("workspace.getFile", {
      workspaceId: "projb-eph-b",
      path: "hello.txt",
    });
    expect(file.content).toBe("hello\ndo not lose me\n");
  }, 240_000);
});
