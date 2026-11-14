// A worktree created with no worker and no placement goes to the repo's primary worker when that
// worker is online and allowed, else to the old default with a notice. A real hub and two real
// `band-worker`s; `callerHostId` is what the relay writes for a call from an agent on a worker.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
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
import { WORKER_BIN } from "./helpers/worker-bin";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

interface Worker {
  hostId: string;
  root: string;
  child: ChildProcess;
}

let server: ServerHandle;
let w1: Worker;
let w2: Worker;

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

interface Created {
  hostId?: string;
  notice?: string;
}
const create = (branch: string, extra: Record<string, unknown> = {}, repo = "proj") =>
  m<Created>("worktrees.create", { repo, branch, ...extra });

async function startWorker(label: string): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `worker-${label}`,
    labels: [`name=${label}`],
  });
  const home = tmp(`band-primary-${label}-home-`);
  const root = tmp(`band-primary-${label}-root-`);
  initRepo(join(root, "proj"));
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
      tmp(`band-primary-${label}-state-`),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        BAND_HOME: join(home, ".band"),
        BAND_TERMINAL_DAEMON: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `worker ${label} online`, timeoutMs: 20_000 },
  );
  return { hostId: issued.hostId, root, child };
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-primary-hub-");
  scratch.push(hubHome);
  const dir = join(tmp("band-primary-hub-proj-"), "proj");
  initRepo(dir);
  seedSettings(hubHome, { tokenSecret: TEST_TOKEN });
  seedState(hubHome, {
    repos: [
      {
        name: "proj",
        path: dir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: dir }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
  w1 = await startWorker("one");
  w2 = await startWorker("two");
  // Map the repo on each worker with a first worktree, then make W2 the primary.
  for (const w of [w1, w2]) {
    await create(`seed-${w.hostId}`, { hostId: w.hostId, hostRepoPath: join(w.root, "proj") });
  }
  await m("repos.update", { name: "proj", primaryHostId: w2.hostId });
}, 180_000);

afterAll(async () => {
  w1?.child.kill("SIGKILL");
  w2?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("a create with no worker", () => {
  it("goes to the primary worker (S1)", async () => {
    const res = await create("to-primary");
    expect(res.hostId).toBe(w2.hostId);
    expect(res.notice).toBeUndefined();
  });

  it("ignores the primary for an explicit worker (S3)", async () => {
    expect((await create("explicit-w1", { hostId: w1.hostId })).hostId).toBe(w1.hostId);
    expect((await create("explicit-local", { hostId: "local" })).hostId).toBe("local");
  });

  it("uses the caller's worker when an agent may not start worktrees elsewhere (S4)", async () => {
    await m("settings.update", { agents: { crossHostWorktrees: false } });
    try {
      const off = await create("agent-off", { callerHostId: w1.hostId });
      expect(off.hostId).toBe(w1.hostId);
      expect(off.notice).toContain("two");
    } finally {
      await m("settings.update", { agents: { crossHostWorktrees: true } });
    }
    expect((await create("agent-on", { callerHostId: w1.hostId })).hostId).toBe(w2.hostId);
  });

  it("falls back to the old default with a notice when the primary is offline (S2)", async () => {
    w2.child.kill("SIGKILL");
    await waitFor(
      async () => {
        const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
        return hosts.find((h) => h.id === w2.hostId)?.status !== "online" ? true : undefined;
      },
      { label: "W2 offline", timeoutMs: 30_000 },
    );
    const res = await create("primary-down");
    expect(res.hostId).toBe("local");
    expect(res.notice).toMatch(/worker-two.*(offline|lost)/);
  });
});
