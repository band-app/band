// Integration tests for what a worker offers (fix/host-capabilities): a real
// `band-worker` process dials a real hub (the production bundle, random port,
// auth on, temp dirs only). The hub stores the worker's agents, roots and home,
// runs the agent refresh on the host that has the agent, expands `~` in a remote
// repository path, and removes an offline host.
//
// The hub's own HOME is empty and its shell is `/bin/sh`, so the hub's machine
// has no OpenCode. The worker's HOME holds an `opencode` script that starts the
// scripted ACP stub agent, so the worker is the only host that can start it.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { waitFor } from "./helpers/wait-for";

const SHARED_TOKEN = "host-capabilities-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const STUB_AGENT = join(import.meta.dirname, "fixtures/acp-stub-agent.mjs");

interface HostView {
  id: string;
  name: string;
  status: "online" | "offline" | "lost" | "disposed";
  agents: string[];
  roots: string[];
  capabilities: string[];
  home: string | null;
}

interface TokenView {
  id: string;
  kind: string;
  hostId: string | null;
  state: string;
}

interface Availability {
  hosts: { id: string; name: string }[];
  defaultHostId: string;
  agents: {
    agentId: string;
    hosts: { hostId: string; available: boolean; reason?: string }[];
  }[];
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

/**
 * Real agent resolution on both machines: no stub for every agent (vitest sets
 * `BAND_TEST_ACP_AGENT` for the suite), a login shell that adds nothing, and a
 * system PATH, so a developer's own OpenCode install is not found.
 */
const agentEnv = {
  BAND_TEST_ACP_AGENT: "",
  SHELL: "/bin/sh",
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
};

let server: ServerHandle;
let workerHome: string;
let workerState: string;
let worker: { child: ChildProcess; exited: Promise<number | null> };
let hostId: string;

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, SHARED_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, SHARED_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

const listHosts = async () => (await q<{ hosts: HostView[] }>("hosts.list")).hosts;
const hostById = async (id: string) => (await listHosts()).find((h) => h.id === id);
const waitForStatus = (id: string, status: HostView["status"]) =>
  waitFor(async () => ((await hostById(id))?.status === status ? true : undefined), {
    label: `host ${id} ${status}`,
    timeoutMs: 20_000,
  });

/** The message of a refused mutation. */
async function mutationError(procedure: string, input: unknown): Promise<string> {
  const res = await trpcMutate(server.url, procedure, input, SHARED_TOKEN);
  expect(res.status).not.toBe(200);
  return await res.text();
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-hostcap-hub-");
  scratch.push(hubHome);
  // The worker's root is its home, so `~/proj` is inside it.
  workerHome = tmp("band-hostcap-whome-");
  workerState = tmp("band-hostcap-state-");
  const opencodeBin = join(workerHome, ".opencode", "bin");
  mkdirSync(opencodeBin, { recursive: true });
  const script = join(opencodeBin, "opencode");
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${STUB_AGENT}"\n`);
  chmodSync(script, 0o755);
  makeRepo(join(workerHome, "proj"));

  const hubRepo = join(tmp("band-hostcap-hubrepo-"), "proj");
  makeRepo(hubRepo);
  seedSettings(hubHome, {
    tokenSecret: SHARED_TOKEN,
    codingAgents: [{ id: "opencode", type: "opencode", label: "OpenCode" }],
  });
  seedState(hubHome, {
    projects: [
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
    env: agentEnv,
  });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "Capable worker",
    labels: [],
  });
  hostId = issued.hostId;
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      workerHome,
      "--state-dir",
      workerState,
    ],
    {
      env: { ...process.env, ...agentEnv, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
      stdio: "ignore",
    },
  );
  worker = { child, exited: new Promise((resolve) => child.once("exit", (c) => resolve(c))) };
  await waitForStatus(hostId, "online");
}, 120_000);

afterAll(async () => {
  worker?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("what a worker reports", () => {
  it("lists its agents, roots, capabilities and home", async () => {
    const host = await hostById(hostId);
    // Claude Code and Codex ship their adapters with the build, so every host has them.
    expect(host?.agents).toEqual(expect.arrayContaining(["opencode"]));
    expect(host?.roots).toEqual([workerHome]);
    expect(host?.home).toBe(workerHome);
    expect(host?.capabilities).toEqual(expect.arrayContaining(["git", "pty"]));
  });

  it("describes the local host too, without the worker's agent", async () => {
    const local = await hostById("local");
    expect(local?.status).toBe("online");
    expect(local?.agents).not.toContain("opencode");
    expect(local?.capabilities).toContain("git");
  });
});

describe("the agent refresh runs on a host that has the agent", () => {
  it("shows which host can start each agent", async () => {
    const availability = await q<Availability>("models.availability", {});
    const row = availability.agents.find((a) => a.agentId === "opencode");
    expect(row?.hosts.find((h) => h.hostId === "local")).toMatchObject({ available: false });
    expect(row?.hosts.find((h) => h.hostId === hostId)).toMatchObject({ available: true });
    expect(availability.defaultHostId).toBe("local");
  });

  it("refreshes on the worker when Local has no such agent", async () => {
    const { results } = await m<{ results: { agentId: string; error?: string }[] }>(
      "models.refresh",
      { agentId: "opencode" },
    );
    expect(results[0]?.agentId).toBe("opencode");
    expect(results[0]?.error).toBeUndefined();
  }, 60_000);

  it("refreshes on a chosen host, and Local reports the missing binary", async () => {
    const onWorker = await m<{ results: { error?: string }[] }>("models.refresh", {
      agentId: "opencode",
      hostId,
    });
    expect(onWorker.results[0]?.error).toBeUndefined();
    const onLocal = await m<{ results: { error?: string }[] }>("models.refresh", {
      agentId: "opencode",
      hostId: "local",
    });
    expect(onLocal.results[0]?.error).toBe("agent binary not found");
  }, 60_000);
});

describe("the repository path on a remote host", () => {
  const create = (hostProjectPath: string, branch: string) =>
    mutationError("workspaces.create", { project: "proj", branch, hostId, hostProjectPath });

  it("rejects a relative path and names what to do", async () => {
    expect(await create("proj", "rel")).toMatch(/relative.*absolute path/s);
  });

  it("names the roots for a directory that does not exist", async () => {
    const message = await create("~/missing", "missing");
    expect(message).toContain(join(workerHome, "missing"));
    expect(message).toContain(`Allowed roots: ${workerHome}`);
  });

  it("names the roots for a path outside every root", async () => {
    const outside = tmp("band-hostcap-outside-");
    const message = await create(outside, "outside");
    expect(message).toMatch(/outside/);
    expect(message).toContain(`Allowed roots: ${workerHome}`);
  });

  it("expands ~ to the worker's home", async () => {
    const created = await m<{ path: string }>("workspaces.create", {
      project: "proj",
      branch: "tilde",
      hostId,
      hostProjectPath: "~/proj",
    });
    expect(created.path).toBe(join(workerHome, ".band-worktrees", "proj", "tilde"));
  });
});

describe("removing a host", () => {
  it("refuses the local host and an online host", async () => {
    expect(await mutationError("hosts.remove", { hostId: "local" })).toMatch(/local host/);
    expect(await mutationError("hosts.remove", { hostId })).toMatch(/online/);
    expect(await hostById(hostId)).toBeDefined();
  });

  it("refuses a host that still has workspaces once it is offline", async () => {
    worker.child.kill("SIGKILL");
    await worker.exited;
    await waitForStatus(hostId, "offline");
    expect(await mutationError("hosts.remove", { hostId })).toMatch(/1 workspace/);
    expect(await hostById(hostId)).toBeDefined();
  }, 60_000);

  it("deletes an offline host with no workspaces and revokes its tokens", async () => {
    const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
      hostName: "Retired",
      labels: [],
    });
    const before = (await q<{ tokens: TokenView[] }>("tokens.list")).tokens;
    expect(before.some((t) => t.hostId === issued.hostId && t.state === "active")).toBe(true);

    await m("hosts.remove", { hostId: issued.hostId });

    expect(await hostById(issued.hostId)).toBeUndefined();
    const after = (await q<{ tokens: TokenView[] }>("tokens.list")).tokens;
    expect(after.some((t) => t.hostId === issued.hostId && t.state === "active")).toBe(false);
    const exchange = await fetch(`${server.url}/api/workers/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.token, workerId: issued.hostId }),
    });
    expect(exchange.status).toBe(401);
  });

  it("is for admin tokens only", async () => {
    const device = await m<{ token: string }>("tokens.createDevice", { label: "viewer" });
    const issued = await m<{ hostId: string }>("tokens.issueWorkerBootstrap", {
      hostName: "Keep",
      labels: [],
    });
    const res = await trpcMutate(
      server.url,
      "hosts.remove",
      { hostId: issued.hostId },
      device.token,
    );
    expect(res.status).toBe(403);
    expect(await hostById(issued.hostId)).toBeDefined();
  });
});
