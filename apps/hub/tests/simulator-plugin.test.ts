// Integration test for the simulator plugin (plugin worker half, plan phase 3). A real hub (the
// production bundle, auth on) and real `band-worker` processes on this Mac. The agent is the scripted
// ACP stub, which calls the plugin's tools through the `band` MCP entry Band passes it. Devices live in
// a Band device set under the worker's temp state dir, and the test shuts down and deletes every device
// it created. It skips without Xcode's `simctl` and `idb`, and needs about 6 GB of memory per booted
// device and 5 GB of disk per device.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
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

function which(bin: string): string | null {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
function hasSimctl(): boolean {
  try {
    execFileSync("xcrun", ["simctl", "help"], { stdio: "ignore" });
    return process.platform === "darwin";
  } catch {
    return false;
  }
}
const IDB = which("idb");
const IDB_COMPANION = which("idb_companion");
const CAN_RUN = hasSimctl() && IDB !== null && IDB_COMPANION !== null;

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

interface Worker {
  hostId: string;
  child: ChildProcess;
  state: string;
  repo: string;
  httpLog: string;
  scenario: string;
}

let server: ServerHandle;
let hubHome: string;
let sim: Worker;
let bare: Worker;
let chatCount = 0;

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

function deviceSet(w: Worker): string {
  return join(w.state, "simulator", "devices");
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
}
function listDevices(w: Worker): SimDevice[] {
  if (!existsSync(deviceSet(w))) return [];
  const out = execFileSync("xcrun", ["simctl", "--set", deviceSet(w), "list", "devices", "-j"], {
    encoding: "utf8",
  });
  return Object.values(
    (JSON.parse(out) as { devices: Record<string, SimDevice[]> }).devices,
  ).flat();
}

async function startWorker(
  name: string,
  opts: { env?: Record<string, string>; path?: string } = {},
): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
    labels: [],
  });
  const home = tmp(`band-sim-${name}-home-`);
  const root = tmp(`band-sim-${name}-root-`);
  const state = tmp(`band-sim-${name}-state-`);
  const repo = join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const httpLog = join(home, "http-log.jsonl");
  const scenario = join(home, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ turns: [] }));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_")),
  );
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
        ...baseEnv,
        ...(opts.path !== undefined ? { PATH: opts.path } : {}),
        HOME: home,
        BAND_HOME: join(home, ".band"),
        BAND_IDB_BIN: IDB as string,
        BAND_IDB_COMPANION_BIN: IDB_COMPANION as string,
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-state"),
        BAND_TEST_ACP_LOG: join(home, "stub-log.jsonl"),
        BAND_TEST_ACP_HTTP_LOG: httpLog,
        BAND_TEST_ACP_SCENARIO: scenario,
        ...opts.env,
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
    { label: `${name} online`, timeoutMs: 30_000 },
  );
  return { hostId: issued.hostId, child, state, repo, httpLog, scenario };
}

async function capabilities(w: Worker): Promise<string[]> {
  const { hosts } = await q<{ hosts: Array<{ id: string; capabilities: string[] }> }>("hosts.list");
  return hosts.find((h) => h.id === w.hostId)?.capabilities ?? [];
}

async function createWorktree(w: Worker, branch: string): Promise<string> {
  await m("worktrees.create", { repo: "proj", branch, hostId: w.hostId, hostRepoPath: w.repo });
  return toWorktreeId("proj", branch, w.hostId);
}

interface ToolReply {
  status: number;
  rpc: { result?: { content?: Array<Record<string, string>>; isError?: boolean } };
}

/** Sends one prompt on a worktree's chat; the stub runs the scenario turn that matches it and logs each tool reply. */
async function turn(
  w: Worker,
  worktreeId: string,
  prompt: string,
  steps: Array<Record<string, unknown>>,
): Promise<Record<string, ToolReply>> {
  const prior = existsSync(w.scenario)
    ? (JSON.parse(readFileSync(w.scenario, "utf8")) as { turns: unknown[] }).turns
    : [];
  writeFileSync(
    w.scenario,
    JSON.stringify({
      turns: [...prior, { match: `^${prompt}$`, steps: [...steps, { say: "done" }] }],
    }),
  );
  // A new chat per turn: a stream on an old chat replays its earlier turn ends.
  const chatId = `sim-chat-${chatCount++}`;
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 240_000 });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text: prompt }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  await stream.events;
  const lines = readFileSync(w.httpLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { name: string; status: number; body: string });
  const out: Record<string, ToolReply> = {};
  for (const l of lines) {
    const data = l.body.split("\n").find((x) => x.startsWith("data:"));
    out[l.name] = {
      status: l.status,
      rpc: JSON.parse(data ? data.slice(5) : l.body || "{}"),
    };
  }
  return out;
}

const call = (name: string, tool: string, args: Record<string, unknown> = {}) => ({
  mcpCall: { name, server: "band", tool, args, fullBody: true },
});

const textOf = (r: ToolReply) =>
  JSON.parse(r.rpc.result?.content?.find((c) => c.type === "text")?.text ?? "{}") as Record<
    string,
    unknown
  >;
const imageOf = (r: ToolReply) => r.rpc.result?.content?.find((c) => c.type === "image");

function cleanupDevices(w: Worker | undefined) {
  if (!w || !existsSync(deviceSet(w))) return;
  try {
    execFileSync("xcrun", ["simctl", "--set", deviceSet(w), "shutdown", "all"], {
      stdio: "ignore",
    });
  } catch {}
  try {
    execFileSync("xcrun", ["simctl", "--set", deviceSet(w), "delete", "all"], { stdio: "ignore" });
  } catch {}
}

let a: string;
let b: string;

beforeAll(async () => {
  if (!CAN_RUN) return;
  const free = execFileSync("df", ["-k", tmpdir()], { encoding: "utf8" })
    .split("\n")[1]
    ?.split(/\s+/)[3];
  if (Number(free) < 15 * 1024 * 1024)
    throw new Error("less than 15 GB of free disk for the simulator test");
  hubHome = createTmpHome("band-sim-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-sim-hubrepo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
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
  // The cap is 1, so booting the second device shuts the first down.
  sim = await startWorker("sim", { env: { BAND_SIMULATOR_MAX_BOOTED: "1" } });
  // A worker with a PATH that has git and nothing else cannot find xcrun.
  const bin = tmp("band-sim-bare-bin-");
  symlinkSync("/usr/bin/git", join(bin, "git"));
  bare = await startWorker("bare", { path: bin });
  a = await createWorktree(sim, "a");
  b = await createWorktree(sim, "b");
}, 300_000);

afterAll(async () => {
  sim?.child.kill("SIGTERM");
  bare?.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 3000));
  sim?.child.kill("SIGKILL");
  bare?.child.kill("SIGKILL");
  cleanupDevices(sim);
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
}, 120_000);

describe.skipIf(!CAN_RUN)("simulator plugin", () => {
  it("S1: a worker with xcrun reports the capability and one without does not", async () => {
    expect(await capabilities(sim)).toContain("simulator");
    expect(await capabilities(bare)).not.toContain("simulator");
  });

  it("S2, S5: each worktree gets its own device, and an argument cannot name another worktree", async () => {
    const ra = await turn(sim, a, "a-status", [
      call("a-status", "simulator_status"),
      call("a-status-spoof", "simulator_status", { worktreeId: b }),
    ]);
    const rb = await turn(sim, b, "b-status", [call("b-status", "simulator_status")]);
    const ua = textOf(ra["a-status"] as ToolReply).udid;
    const ub = textOf(rb["b-status"] as ToolReply).udid;
    expect(ua).toBeTruthy();
    expect(ub).toBeTruthy();
    expect(ua).not.toBe(ub);
    // The extra argument is dropped, so the spoofed call still answers with A's device.
    expect(textOf(ra["a-status-spoof"] as ToolReply).udid).toBe(ua);
    expect(listDevices(sim).map((d) => d.udid)).toEqual(expect.arrayContaining([ua, ub]));
  }, 300_000);

  it("S2, S3: A's agent gets a PNG, and opening a URL, tapping and typing change the screen", async () => {
    const r = await turn(sim, a, "a-drive", [
      call("shot1", "simulator_screenshot"),
      call("open", "simulator_open_url", { url: "data:text/html,<h1>band</h1>" }),
      { sleep: 3000 },
      call("shot2", "simulator_screenshot"),
      call("tap", "simulator_tap", { x: 200, y: 820 }),
      call("type", "simulator_type", { text: "band" }),
      { sleep: 2000 },
      call("shot3", "simulator_screenshot"),
      { sleep: 3000 },
      call("shot4", "simulator_screenshot"),
    ]);
    const png = (name: string) => imageOf(r[name] as ToolReply);
    for (const name of ["shot1", "shot2", "shot3", "shot4"]) {
      expect(png(name)?.mimeType).toBe("image/png");
      expect(
        Buffer.from(png(name)?.data ?? "", "base64")
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
    }
    expect(png("shot1")?.data).not.toBe(png("shot2")?.data);
    // The keyboard may take longer than a fixed wait to appear, so one of two later shots must differ.
    const later = [png("shot3")?.data, png("shot4")?.data];
    expect(later.some((d) => d !== png("shot2")?.data)).toBe(true);
    expect(r.tap?.rpc.result?.isError).toBeFalsy();
    expect(r.type?.rpc.result?.isError).toBeFalsy();
  }, 400_000);

  it("S4: booting B shuts down A at a cap of 1, and removing A deletes its device", async () => {
    const before = listDevices(sim);
    const statusA = await turn(sim, a, "a-udid", [call("a-udid", "simulator_status")]);
    const ua = textOf(statusA["a-udid"] as ToolReply).udid as string;
    expect(before.find((d) => d.udid === ua)?.state).toBe("Booted");
    await turn(sim, b, "b-shot", [call("b-shot", "simulator_screenshot")]);
    const after = listDevices(sim);
    expect(after.find((d) => d.udid === ua)?.state).toBe("Shutdown");
    expect(after.filter((d) => d.state === "Booted")).toHaveLength(1);

    await m("worktrees.remove", { repo: "proj", name: "a", hostId: sim.hostId });
    await waitFor(async () => (listDevices(sim).some((d) => d.udid === ua) ? undefined : true), {
      label: "A's device deleted",
      timeoutMs: 60_000,
    });
  }, 400_000);

  it("S6: a worktree on a worker without the capability gets an error naming the worker", async () => {
    const c = await createWorktree(bare, "c");
    const r = await turn(bare, c, "c-status", [call("c-status", "simulator_status")]);
    const reply = r["c-status"] as ToolReply;
    expect(reply.rpc.result?.isError).toBe(true);
    const text = reply.rpc.result?.content?.[0]?.text ?? "";
    expect(text).toContain(bare.hostId);
    expect(text).toContain("simulator");
  }, 120_000);

  it("S7: stopping the worker shuts its devices down", async () => {
    expect(listDevices(sim).some((d) => d.state === "Booted")).toBe(true);
    sim.child.kill("SIGTERM");
    await waitFor(
      async () => (listDevices(sim).some((d) => d.state === "Booted") ? undefined : true),
      { label: "devices shut down", timeoutMs: 60_000 },
    );
  }, 120_000);
});
