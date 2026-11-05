// Integration test for extension worker services (docs/extensions.md). A real hub and two real
// `band-worker` processes. The echo-service fixture extension is installed on the hub; each
// eligible worker downloads it, runs it as its own process and answers the hub's calls and streams.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { echoArchive } from "./helpers/extension-archive";
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
  state: string;
  child: ChildProcess;
  worktreeId: string;
}

let server: ServerHandle;
let a: Worker;
let b: Worker;

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

interface ServiceView {
  extensionId: string;
  capability: string;
  version: string;
  state: string;
  reason?: string;
}
const servicesOf = async (w: Worker): Promise<ServiceView[]> => {
  const { hosts } = await q<{ hosts: Array<{ id: string; extensionServices: ServiceView[] }> }>(
    "hosts.list",
  );
  return hosts.find((h) => h.id === w.hostId)?.extensionServices ?? [];
};
const stateOf = async (w: Worker) => (await servicesOf(w))[0]?.state;
const call = async <T>(w: Worker, method: string, params: unknown = {}) =>
  (
    await m<{ result: T }>("extensions.callService", {
      worktreeId: w.worktreeId,
      capability: "echo",
      method,
      params,
    })
  ).result;
const upload = (bytes: Buffer) =>
  fetch(`${server.url}/api/extensions/install`, {
    method: "POST",
    headers: { Cookie: `band_token=${TEST_TOKEN}` },
    body: bytes,
  });
const install = async (opts: Parameters<typeof echoArchive>[0]) => {
  const res = await upload(echoArchive(opts).bytes);
  expect(res.status).toBe(200);
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function startWorker(label: string): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `worker-${label}`,
    labels: [],
  });
  const home = tmp(`band-extsvc-${label}-home-`);
  const root = tmp(`band-extsvc-${label}-root-`);
  const state = tmp(`band-extsvc-${label}-state-`);
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
      state,
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
    { label: `worker ${label} online`, timeoutMs: 30_000 },
  );
  await m("worktrees.create", {
    repo: "proj",
    branch: `seed-${label}`,
    hostId: issued.hostId,
    hostRepoPath: join(root, "proj"),
  });
  return {
    hostId: issued.hostId,
    root,
    state,
    child,
    worktreeId: toWorktreeId("proj", `seed-${label}`, issued.hostId),
  };
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-extsvc-hub-");
  scratch.push(hubHome);
  const dir = join(tmp("band-extsvc-hub-proj-"), "proj");
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
  a = await startWorker("a");
  b = await startWorker("b");
  // B is restricted before anything is installed.
  await m("hosts.setTrust", { hostId: b.hostId, trust: "restricted" });
}, 240_000);

afterAll(async () => {
  a?.child.kill("SIGKILL");
  b?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("extension worker services", () => {
  it("S1: a standard worker downloads, runs and answers calls; a restricted one never starts it (S2)", async () => {
    await install({ version: "1.0.0" });
    await waitFor(async () => ((await stateOf(a)) === "running" ? true : undefined), {
      label: "service running on A",
      timeoutMs: 30_000,
    });
    expect(await call(a, "echo", { hello: "world" })).toEqual({ hello: "world" });
    expect(await call(a, "workerId")).toBe(a.hostId);
    expect(existsSync(join(a.state, "extensions", "echo-service", "1.0.0", "service.mjs"))).toBe(
      true,
    );

    const onB = await servicesOf(b);
    expect(onB).toMatchObject([
      { extensionId: "echo-service", state: "not-eligible", reason: "restricted" },
    ]);
    expect(existsSync(join(b.state, "extensions", "echo-service"))).toBe(false);
    await expect(call(b, "echo")).rejects.toThrow();
  });

  it("S2: lowering a standard worker to restricted stops its service, and raising it starts it again", async () => {
    const pid = await call<number>(a, "pid");
    await m("hosts.setTrust", { hostId: a.hostId, trust: "restricted" });
    await waitFor(async () => (!alive(pid) ? true : undefined), {
      label: "service stopped",
      timeoutMs: 20_000,
    });
    expect(await servicesOf(a)).toMatchObject([{ state: "not-eligible", reason: "restricted" }]);
    expect(existsSync(join(a.state, "extensions", "echo-service"))).toBe(false);

    await m("hosts.setTrust", { hostId: a.hostId, trust: "standard" });
    await waitFor(async () => ((await stateOf(a)) === "running" ? true : undefined), {
      label: "service running again",
      timeoutMs: 30_000,
    });
    expect(await call(a, "echo", { n: 1 })).toEqual({ n: 1 });
  });

  it("S6: a stream delivers its frames in order and closing it ends the stream in the process", async () => {
    const url = `${server.url.replace("http", "ws")}/api/plugins/echo/worktrees/${encodeURIComponent(a.worktreeId)}/stream`;
    const ws = new WebSocket(url, { headers: { Cookie: `band_token=${TEST_TOKEN}` } });
    const frames: Array<string | number[]> = [];
    ws.on("message", (data, isBinary) => {
      frames.push(isBinary ? [...(data as Buffer)] : data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await waitFor(() => (frames.length >= 5 ? true : undefined), {
      label: "5 frames",
      timeoutMs: 20_000,
    });
    expect(frames.slice(0, 5)).toEqual(["frame-0", [1], "frame-2", [3], "frame-4"]);
    ws.close();
    await waitFor(async () => ((await call<number>(a, "closedStreams")) >= 1 ? true : undefined), {
      label: "the process saw the stream close",
      timeoutMs: 20_000,
    });
  });

  it("S3: a service whose requirements are not met does not start and says why", async () => {
    await install({ version: "1.1.0", requires: ["os=nonexistent"] });
    await waitFor(async () => ((await stateOf(a)) === "not-eligible" ? true : undefined), {
      label: "not eligible",
      timeoutMs: 30_000,
    });
    expect((await servicesOf(a))[0]?.reason).toMatch(/needs os=nonexistent/);
  });

  it("S4: an update swaps the process and removes the old folder; uninstall stops and removes it", async () => {
    await install({ version: "2.0.0" });
    await waitFor(
      async () =>
        (await servicesOf(a))[0]?.version === "2.0.0" && (await stateOf(a)) === "running"
          ? true
          : undefined,
      {
        label: "v2 running",
        timeoutMs: 30_000,
      },
    );
    expect(await call(a, "version")).toBe("2.0.0");
    expect(existsSync(join(a.state, "extensions", "echo-service", "1.0.0"))).toBe(false);
    expect(existsSync(join(a.state, "extensions", "echo-service", "1.1.0"))).toBe(false);

    const pid = await call<number>(a, "pid");
    await m("extensions.remove", { id: "echo-service" });
    await waitFor(async () => (!alive(pid) ? true : undefined), {
      label: "service stopped",
      timeoutMs: 20_000,
    });
    expect(existsSync(join(a.state, "extensions", "echo-service"))).toBe(false);
    expect(await servicesOf(a)).toEqual([]);
  });
});
