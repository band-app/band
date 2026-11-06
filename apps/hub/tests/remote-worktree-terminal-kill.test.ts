// Removing a worktree ends its terminals on the worktree's own worker. The hub deletes the worktree's
// row first, so a lookup of the host afterwards falls back to `local` and the kill never reached the
// worker. A worker that connects also has its terminals for worktrees the hub no longer knows ended.
// A real hub and a real `band-worker` (with its terminal daemon) run here; each shell records its pid.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
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
import { toWorktreeId } from "@band-app/shared/worktree-id";
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
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";
import { WORKER_BIN } from "./helpers/worker-bin";

const TOKEN = "remote-terminal-kill-token";
const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let server: ServerHandle;
let hostId: string;
let worker: ChildProcess | null = null;
let workerArgs: string[] = [];
let workerEnv: NodeJS.ProcessEnv = {};
let stateDir: string;
const sockets: TerminalSocket[] = [];

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

function launchWorker(): void {
  worker = spawn(process.execPath, [WORKER_BIN, ...workerArgs], {
    env: workerEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout?.on("data", () => undefined);
  worker.stderr?.on("data", () => undefined);
}

const workerStatus = async (): Promise<string | undefined> =>
  (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
    (h) => h.id === hostId,
  )?.status;

/** Opens a shell in the worktree and returns the shell's pid, which it writes to a file. */
async function openShell(worktreeId: string, name: string, dir: string): Promise<number> {
  const created = await m<{ terminalId: string }>("terminal.create", { worktreeId });
  const socket = await TerminalSocket.open(server, {
    worktreeId,
    terminalId: created.terminalId,
    token: TOKEN,
  });
  sockets.push(socket);
  const file = join(dir, `${name}.pid`);
  socket.type(`echo $$ > ${file}; echo wrote-${name}-$((0+1))\r`);
  await socket.waitForOutput(`wrote-${name}-1`);
  return Number(readFileSync(file, "utf8").trim());
}

const remoteWt = (branch: string) => toWorktreeId("proj", branch, hostId);
const localWt = (branch: string) => toWorktreeId("proj", branch, "local");

beforeAll(async () => {
  const hubHome = createTmpHome("band-rtk-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-rtk-hubrepo-"), "proj");
  initRepo(hubRepo);
  seedSettings(hubHome, { tokenSecret: TOKEN });
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
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "worker-w",
    labels: ["name=w"],
  });
  hostId = issued.hostId;
  const home = tmp("band-rtk-home-");
  const root = tmp("band-rtk-root-");
  initRepo(join(root, "proj"));
  stateDir = tmp("band-rtk-state-");
  workerArgs = [
    "--hub",
    server.url,
    "--token",
    issued.token,
    "--root",
    root,
    "--state-dir",
    stateDir,
  ];
  // The terminal daemon stays on, so a shell outlives the worker process.
  workerEnv = { ...process.env, HOME: home, BAND_HOME: join(home, ".band") };
  launchWorker();
  await waitFor(async () => ((await workerStatus()) === "online" ? true : undefined), {
    label: "worker online",
    timeoutMs: 30_000,
  });
  for (const branch of ["doomed", "doomed-offline", "keep"]) {
    await m("worktrees.create", {
      repo: "proj",
      branch,
      hostId,
      hostRepoPath: join(root, "proj"),
    });
  }
  await m("worktrees.create", { repo: "proj", branch: "local-doomed" });
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  const runDir = join(stateDir ?? "", "run");
  if (stateDir && existsSync(runDir)) {
    for (const name of readdirSync(runDir).filter((n) => /^terminal-daemon.*\.pid$/.test(n))) {
      try {
        const { pid } = JSON.parse(readFileSync(join(runDir, name), "utf8")) as { pid: number };
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  // The daemon is gone, so the sockets are closed without waiting for a clean goodbye.
  await Promise.race([
    Promise.all(sockets.map((socket) => socket.close().catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("terminals of a removed worktree", () => {
  it("S1: ends the shell on the remote worker when the worktree is removed", async () => {
    const pid = await openShell(remoteWt("doomed"), "doomed", stateDir);
    expect(alive(pid)).toBe(true);
    await m("worktrees.remove", { repo: "proj", name: "doomed", hostId });
    await waitFor(async () => (alive(pid) ? undefined : true), {
      label: "remote shell ended",
      timeoutMs: 20_000,
    });
  }, 60_000);

  it("S2: ends the shell of a worktree on the hub's own machine", async () => {
    const pid = await openShell(localWt("local-doomed"), "local-doomed", stateDir);
    expect(alive(pid)).toBe(true);
    await m("worktrees.remove", { repo: "proj", name: "local-doomed" });
    await waitFor(async () => (alive(pid) ? undefined : true), {
      label: "local shell ended",
      timeoutMs: 20_000,
    });
  }, 60_000);

  it("S3: a connecting worker has the terminals of unknown worktrees ended and keeps the rest", async () => {
    const doomedPid = await openShell(remoteWt("doomed-offline"), "doomed-offline", stateDir);
    const keepPid = await openShell(remoteWt("keep"), "keep", stateDir);
    // The worker dies and its daemon keeps both shells. The worktree is removed while it is away.
    worker?.kill("SIGKILL");
    await waitFor(async () => ((await workerStatus()) !== "online" ? true : undefined), {
      label: "worker offline",
      timeoutMs: 30_000,
    });
    expect(alive(doomedPid)).toBe(true);
    await m("worktrees.remove", { repo: "proj", name: "doomed-offline", hostId });
    expect(alive(doomedPid)).toBe(true);
    launchWorker();
    await waitFor(async () => (alive(doomedPid) ? undefined : true), {
      label: "orphan shell ended after reconnect",
      timeoutMs: 30_000,
    });
    expect(alive(keepPid)).toBe(true);
  }, 120_000);
});
