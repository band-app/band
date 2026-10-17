// A worker on battery is polled at the slowest cadence and never fetched, whatever the UIs report;
// a worker on AC keeps the cadence the UIs ask for. Two real `band-worker`s dial a real hub. The
// workers' `BAND_POWER_STATE` pins their reading (the real one is `pmset` or /sys/class/power_supply),
// and `GIT_TRACE` in their environment records every git command they run.

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

import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const TOKEN = "host-battery-token";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

interface Worker {
  hostId: string;
  root: string;
  repo: string;
  trace: string;
  child: ChildProcess;
}

let server: ServerHandle;
let hubHome: string;
const children: ChildProcess[] = [];

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

async function startWorker(label: string, power: "battery" | "ac"): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `worker-${label}`,
    labels: [`name=${label}`],
  });
  const home = tmp(`band-battery-${label}-home-`);
  const root = tmp(`band-battery-${label}-root-`);
  const repo = join(root, "proj");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const trace = join(home, "git-trace.log");
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      root,
      "--state-dir",
      tmp(`band-battery-${label}-state-`),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        BAND_HOME: join(home, ".band"),
        BAND_TERMINAL_DAEMON: "0",
        BAND_POWER_STATE: power,
        GIT_TRACE: trace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  await waitFor(
    async () => {
      const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
      const { hosts } = await trpcData<{ hosts: Array<{ id: string; status: string }> }>(res);
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `worker ${label} online`, timeoutMs: 20_000 },
  );
  return { hostId: issued.hostId, root, repo, trace, child };
}

/** Where each worker's git trace stood when the test began to watch it. */
const marks = new Map<Worker, number>();
const traceHas = (w: Worker, needle: string): boolean =>
  existsSync(w.trace) &&
  readFileSync(w.trace, "utf8")
    .slice(marks.get(w) ?? 0)
    .includes(needle);

describe("a worker on battery is polled slowly and not fetched", () => {
  let battery: Worker;
  let plugged: Worker;
  let stream: StatusStream;
  let batteryWt: string;
  let pluggedWt: string;

  beforeAll(async () => {
    hubHome = createTmpHome("band-battery-hub-");
    scratch.push(hubHome);
    const hubRepo = join(tmp("band-battery-hub-repo-"), "proj");
    mkdirSync(hubRepo);
    git(hubRepo, "init", "-q", "-b", "main");
    writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
    git(hubRepo, "add", ".");
    git(hubRepo, "commit", "-q", "-m", "init");
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
      env: { BAND_SERVE_UI: "false", BAND_ACTIVITY_DEFAULT: "idle" },
    });
    battery = await startWorker("battery", "battery");
    plugged = await startWorker("plugged", "ac");
    await m("worktrees.create", {
      repo: "proj",
      branch: "on-battery",
      hostId: battery.hostId,
      hostRepoPath: battery.repo,
    });
    await m("worktrees.create", {
      repo: "proj",
      branch: "on-ac",
      hostId: plugged.hostId,
      hostRepoPath: plugged.repo,
    });
    batteryWt = toWorktreeId("proj", "on-battery", battery.hostId);
    pluggedWt = toWorktreeId("proj", "on-ac", plugged.hostId);
  }, 90_000);

  afterAll(async () => {
    stream?.close();
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
            child.once("exit", () => {
              clearTimeout(kill);
              resolve();
            });
          }),
      ),
    );
    await server?.close();
    for (const dir of scratch)
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("polls the battery host's worktree at the background cadence and skips its git fetch", async () => {
    // An active UI: the poller ticks every 5 s and fetches on every sixth tick (30 s).
    await m("services.setActivity", { activity: "active", clientId: "ui" });
    stream = await StatusStream.open(server.url, TOKEN);
    const keepAlive = setInterval(
      () => void m("services.setActivity", { activity: "active", clientId: "ui" }),
      20_000,
    );
    try {
      await waitFor(async () => stream.latest(batteryWt) && stream.latest(pluggedWt), {
        label: "first poll of both worktrees",
        timeoutMs: 20_000,
      });
      const batteryPath = join(battery.root, ".band-worktrees", "proj", "on-battery");
      const pluggedPath = join(plugged.root, ".band-worktrees", "proj", "on-ac");
      // Fetches made while the workers were set up don't count; only those after this point do.
      const traceMark = (w: Worker) =>
        existsSync(w.trace) ? readFileSync(w.trace, "utf8").length : 0;
      marks.set(battery, traceMark(battery));
      marks.set(plugged, traceMark(plugged));
      writeFileSync(join(batteryPath, "edited.txt"), "x\n");
      writeFileSync(join(pluggedPath, "edited.txt"), "x\n");

      // The plugged-in worktree shows its edit on the 5 s cadence.
      await waitFor(async () => stream.latest(pluggedWt)?.dirty === true, {
        label: "plugged-in worktree shows its edit",
        timeoutMs: 15_000,
      });
      // The battery host's has not been looked at again, which is a minute apart.
      expect(stream.latest(batteryWt)?.dirty).toBe(false);

      // Past the first CI tick (6 x 5 s), the plugged-in host was fetched and the battery host was not.
      await waitFor(async () => traceHas(plugged, "fetch") || undefined, {
        label: "plugged-in host fetched",
        timeoutMs: 40_000,
        intervalMs: 1_000,
      });
      expect(traceHas(battery, "fetch")).toBe(false);
    } finally {
      clearInterval(keepAlive);
    }
  }, 90_000);
});
