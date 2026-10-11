import { toWorktreeId } from "@band-app/shared/worktree-id";
// A worktree that git registered for a repo inside a worker root may live outside the roots
// (another tool made it). The hub imports it with the repo, and a terminal opens there through the
// hub API. A folder that is not a registered worktree stays refused. Real hub, real `band-worker`
// binary, everything in temp dirs.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
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

const SHARED_TOKEN = "worktrees-outside-roots-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

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

let server: ServerHandle;
let workerRoot: string;
let workerState: string;
let workerHome: string;
let outsideDir: string;
let worker: WorkerProcess;
let hostId: string;
let repoPath: string;
let worktreePath: string;

interface WorkerProcess {
  child: ChildProcess;
  output(): string;
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
  return { child, output: () => output };
}

const trpcQ = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, SHARED_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const trpcM = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, SHARED_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

beforeAll(async () => {
  const hubHome = createTmpHome("band-outside-hub-");
  scratch.push(hubHome);
  workerRoot = tmp("band-outside-root-");
  workerState = tmp("band-outside-state-");
  workerHome = tmp("band-outside-whome-");
  outsideDir = tmp("band-outside-wt-");

  repoPath = join(workerRoot, "proj");
  mkdirSync(repoPath);
  git(repoPath, "init", "-q", "-b", "main");
  writeFileSync(join(repoPath, "hello.txt"), "hello\n");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-q", "-m", "init");
  worktreePath = join(outsideDir, "feature-tree");
  git(repoPath, "worktree", "add", "-q", "-b", "outside-feat", worktreePath);
  mkdirSync(join(outsideDir, "not-a-worktree"));

  seedSettings(hubHome, { tokenSecret: SHARED_TOKEN });
  server = await startServer({ tmpHome: hubHome });

  const issued = await trpcM<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "Outside worker",
    labels: ["test"],
  });
  hostId = issued.hostId;
  worker = startWorkerProcess(issued.token);
  await waitFor(
    async () => {
      const { hosts } = await trpcQ<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === hostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 15_000 },
  );
}, 120_000);

afterAll(async () => {
  worker?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("a registered worktree outside the worker's roots", () => {
  it("opens a terminal in it through the hub", async () => {
    await trpcM("repos.addFromWorker", { hostId, path: repoPath });
    const worktreeId = toWorktreeId("proj", "outside-feat", hostId);
    const { repos } = await trpcQ<{
      repos: Array<{ name: string; worktrees: Array<{ name: string; path: string }> }>;
    }>("repos.list");
    const wt = repos.find((r) => r.name === "proj")?.worktrees.find((w) => w.path === worktreePath);
    expect(wt).toBeDefined();

    const created = await trpcM<{ terminalId: string }>("terminal.create", { worktreeId });
    const socket = await TerminalSocket.open(server, {
      worktreeId,
      terminalId: created.terminalId,
      token: SHARED_TOKEN,
    });
    try {
      socket.type("echo cwd=$PWD\r");
      await socket.waitForOutput(`cwd=${worktreePath}`);
    } finally {
      await socket.close();
    }
  });

  it("still refuses a folder that is no registered worktree", async () => {
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      {
        repo: "proj",
        branch: "elsewhere",
        hostId,
        hostRepoPath: join(outsideDir, "not-a-worktree"),
      },
      SHARED_TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).toMatch(/outside the directories host/);
  });
});
