// Integration tests for remote hosts (plan step 2.3): a real `band-worker`
// process dials a real hub, registers through the bootstrap exchange, and a
// worktree on that host runs files, git and a terminal on the worker. The hub
// is the production bundle (`dist/start-server.mjs`) on a random port with
// auth on, and everything lives in temp dirs.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const SHARED_TOKEN = "remote-host-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface HostView {
  id: string;
  name: string;
  status: "online" | "offline" | "lost" | "disposed";
  lastSeenAt: number | null;
  info: { roots?: string[]; os?: string } | null;
}

interface TokenView {
  id: string;
  kind: string;
  hostId: string | null;
  state: string;
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

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello from the repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

let hubHome: string;
let server: ServerHandle;
let workerRoot: string;
let workerState: string;
let workerHome: string;
let worker: WorkerProcess;
let bootstrapToken = "";
let hostId: string;

interface WorkerProcess {
  child: ChildProcess;
  output(): string;
  exited: Promise<number | null>;
}

function startWorkerProcess(token: string): WorkerProcess {
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      token,
      "--root",
      workerRoot,
      "--state-dir",
      workerState,
    ],
    {
      env: { ...process.env, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (d) => {
    output += d;
  });
  child.stderr?.on("data", (d) => {
    output += d;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return { child, output: () => output, exited };
}

const trpcQ = <T>(procedure: string, input?: unknown, token = SHARED_TOKEN) =>
  trpcQuery(server.url, procedure, input, token).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const trpcM = <T>(procedure: string, input: unknown, token = SHARED_TOKEN) =>
  trpcMutate(server.url, procedure, input, token).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

async function listHosts(): Promise<HostView[]> {
  return (await trpcQ<{ hosts: HostView[] }>("hosts.list")).hosts;
}
const hostStatus = async () => (await listHosts()).find((h) => h.id === hostId)?.status;
const waitForStatus = (status: HostView["status"], timeoutMs = 15_000) =>
  waitFor(async () => ((await hostStatus()) === status ? true : undefined), {
    label: `host ${status}`,
    timeoutMs,
  });

async function issueBootstrap(name: string): Promise<{ token: string; hostId: string }> {
  return trpcM("tokens.issueWorkerBootstrap", { hostName: name, labels: ["test"] });
}

async function exchange(token: string, workerId?: string): Promise<Response> {
  return fetch(`${server.url}/api/workers/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, workerId }),
  });
}

const worktreeId = "proj-remote-feat";

beforeAll(async () => {
  hubHome = createTmpHome("band-remote-hub-");
  scratch.push(hubHome);
  workerRoot = tmp("band-remote-root-");
  workerState = tmp("band-remote-state-");
  workerHome = tmp("band-remote-whome-");

  // The hub knows the repo at a local path. The worker has its own checkout.
  const hubRepo = join(tmp("band-remote-hubrepo-"), "proj");
  makeRepo(hubRepo);
  makeRepo(join(workerRoot, "proj"));
  seedSettings(hubHome, { tokenSecret: SHARED_TOKEN });
  seedState(hubHome, {
    repos: [
      {
        name: "proj",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({ tmpHome: hubHome });

  const issued = await issueBootstrap("Test worker");
  hostId = issued.hostId;
  bootstrapToken = issued.token;
  worker = startWorkerProcess(issued.token);
  await waitForStatus("online");
}, 120_000);

afterAll(async () => {
  worker?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("registering a worker", () => {
  it("shows the worker online with what it reported, and refuses a second exchange", async () => {
    const host = (await listHosts()).find((h) => h.id === hostId);
    expect(host).toMatchObject({ name: "Test worker", status: "online" });
    expect(host?.lastSeenAt).toBeGreaterThan(0);
    expect(host?.info?.roots).toEqual([workerRoot]);

    // The bootstrap token was spent by the worker's own exchange.
    const tokens = (await trpcQ<{ tokens: TokenView[] }>("tokens.list")).tokens;
    const bootstrap = tokens.find((t) => t.kind === "worker_bootstrap" && t.hostId === hostId);
    expect(bootstrap?.state).toBe("used");
    expect((await exchange(bootstrapToken, hostId)).status).toBe(401);
    const fresh = await issueBootstrap("Exchanged by hand");
    expect((await exchange(fresh.token)).status).toBe(200);
    expect((await exchange(fresh.token)).status).toBe(401);
  });

  it("binds a bootstrap token to the host it was issued for", async () => {
    const a = await issueBootstrap("A");
    const b = await issueBootstrap("B");
    expect((await exchange(a.token, b.hostId)).status).toBe(401);
    const ok = await exchange(a.token, a.hostId);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ workerId: a.hostId });
  });
});

describe("a worktree on the remote host", () => {
  it("creates the worktree under the worker's root", async () => {
    const created = await trpcM<{ path: string }>("worktrees.create", {
      repo: "proj",
      branch: "remote-feat",
      hostId,
      hostRepoPath: join(workerRoot, "proj"),
    });
    expect(created.path).toBe(join(workerRoot, ".band-worktrees", "proj", "remote-feat"));
    const { repos } = await trpcQ<{
      repos: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
    }>("repos.list");
    const wt = repos
      .find((p) => p.name === "proj")
      ?.worktrees.find((w) => w.name === "remote-feat");
    expect(wt?.hostId).toBe(hostId);
  });

  it("lists, reads and writes files and runs git on the worker", async () => {
    const files = await trpcQ<{ entries: Array<{ name: string }> }>("worktree.listFiles", {
      worktreeId,
      path: "",
    });
    expect(files.entries.map((e) => e.name)).toContain("hello.txt");

    await trpcM("worktree.createFile", {
      worktreeId,
      path: "note.txt",
      content: "from the hub\n",
    });
    const saved = await trpcQ<{ content: string }>("worktree.getFile", {
      worktreeId,
      path: "note.txt",
    });
    expect(saved.content).toBe("from the hub\n");
    // The file is on the worker's disk, in the worktree the worker made.
    expect(
      git(join(workerRoot, ".band-worktrees", "proj", "remote-feat"), "status", "--porcelain"),
    ).toContain("note.txt");

    const changes = JSON.stringify(await trpcQ("worktree.getChanges", { worktreeId }));
    expect(changes).toContain("note.txt");
  });

  it("refuses a path that leaves the worker's roots with the policy error", async () => {
    const outside = tmp("band-remote-outside-");
    writeFileSync(join(outside, "secret.txt"), "not yours\n");
    symlinkSync(outside, join(workerRoot, ".band-worktrees", "proj", "remote-feat", "escape"));
    const res = await trpcQuery(
      server.url,
      "worktree.getFile",
      { worktreeId, path: "escape/secret.txt" },
      SHARED_TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).toMatch(/outside the worker's roots/);

    for (const path of ["escape/pwn.txt", "../../pwn.txt"]) {
      const write = await trpcMutate(
        server.url,
        "worktree.createFile",
        { worktreeId, path, content: "x" },
        SHARED_TOKEN,
      );
      expect(write.status).not.toBe(200);
    }
    expect(existsSync(join(outside, "pwn.txt"))).toBe(false);
  });

  it("keeps the remote worktree through a sync and leaves local ones alone", async () => {
    const { repos } = await trpcQ<{
      repos: Array<{ name: string; worktrees: Array<{ name: string }> }>;
    }>("repos.list");
    const names = repos.find((p) => p.name === "proj")?.worktrees.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(["main", "remote-feat"]));
    // Local worktrees still read their files from the hub's disk.
    const local = await trpcQ<{ entries: Array<{ name: string }> }>("worktree.listFiles", {
      worktreeId: "proj-main",
      path: "",
    });
    expect(local.entries.map((e) => e.name)).toContain("hello.txt");
  });

  it("streams a shell from the worker", async () => {
    const created = await trpcM<{ terminalId: string }>("terminal.create", { worktreeId });
    const socket = await TerminalSocket.open(server, {
      worktreeId,
      terminalId: created.terminalId,
      token: SHARED_TOKEN,
    });
    try {
      // The shell's parent is the worker process, so the PTY runs on the worker.
      socket.type("echo parent=$(ps -o ppid= -p $$ | tr -d ' ') pwd=$PWD\r");
      await socket.waitForOutput(`parent=${worker.child.pid} pwd=`);
      await socket.waitForOutput(join(workerRoot, ".band-worktrees", "proj", "remote-feat"));
    } finally {
      await socket.close();
    }
  });
});

describe("losing and regaining the worker", () => {
  it("marks the host offline when the worker dies and online when it restarts", async () => {
    worker.child.kill("SIGKILL");
    await worker.exited;
    await waitForStatus("offline", 20_000);

    // Calls to an offline host fail, local worktrees still work.
    const res = await trpcQuery(
      server.url,
      "worktree.listFiles",
      { worktreeId, path: "" },
      SHARED_TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).toMatch(/offline/);
    const local = await trpcQ<{ entries: unknown[] }>("worktree.listFiles", {
      worktreeId: "proj-main",
      path: "",
    });
    expect(local.entries.length).toBeGreaterThan(0);

    // The saved session token is enough to come back; the bootstrap token was spent.
    worker = startWorkerProcess("bwb_unused-because-the-session-token-is-saved");
    await waitForStatus("online", 20_000);
    const files = await trpcQ<{ entries: Array<{ name: string }> }>("worktree.listFiles", {
      worktreeId,
      path: "",
    });
    expect(files.entries.map((e) => e.name)).toContain("note.txt");
  }, 90_000);
});

describe("credentials", () => {
  it("does not let a device token connect as a worker", async () => {
    const reply = await helloReply(SHARED_TOKEN, hostId);
    expect(reply).toMatchObject({ type: "rejected" });
  });

  it("does not let a worker session token call the device API", async () => {
    const issued = await issueBootstrap("Session only");
    const { sessionToken } = (await (await exchange(issued.token)).json()) as {
      sessionToken: string;
    };
    const res = await fetch(`${server.url}/trpc/hosts.list`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(res.status).toBe(401);
    const withCookie = await trpcQuery(server.url, "hosts.list", undefined, sessionToken);
    expect(withCookie.status).toBe(401);
  });

  it("cuts a worker off when its session token is revoked, and keeps it out", async () => {
    const session = (await trpcQ<{ tokens: TokenView[] }>("tokens.list")).tokens.find(
      (t) => t.kind === "worker_session" && t.hostId === hostId && t.state === "active",
    );
    expect(session).toBeDefined();
    await trpcM("tokens.revoke", { tokenId: session?.id });

    // The worker is disconnected, redials with the revoked token and exits.
    expect(await worker.exited).toBe(1);
    await waitForStatus("offline");
    expect(worker.output()).toMatch(/rejected/);

    // A restart with the saved token is refused as well.
    const again = startWorkerProcess("bwb_unused");
    expect(await again.exited).toBe(1);
    expect(await hostStatus()).toBe("offline");
  }, 90_000);

  it("refuses an exchange with no token", async () => {
    const res = await fetch(`${server.url}/api/workers/exchange`, { method: "POST", body: "{}" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

/** Opens the link as a worker would and returns the hub's first reply to a `hello`. */
function helloReply(token: string, workerId: string): Promise<{ type: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/workers/connect`);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: 1,
          workerId,
          token,
          buildId: "test",
          mode: "attached",
          capabilities: [],
          labels: {},
          roots: [],
          agents: [],
        }),
      ),
    );
    ws.on("message", (data) => {
      resolve(JSON.parse(data.toString()));
      ws.close();
    });
    ws.on("error", reject);
  });
}
