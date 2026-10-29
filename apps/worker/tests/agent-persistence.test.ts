import assert from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { agentDaemonPaths, agentRunDir } from "@band-app/host-local/agents/daemon/protocol";
import type { Channel, ServerSession } from "@band-app/link";
import { stopAgentDaemons } from "../src/agents.ts";
import {
  call,
  cleanup,
  spawnWorkerProcess,
  startHub,
  type TestHub,
  TOKEN,
  tmpDir,
  type WorkerProcess,
  waitFor,
} from "./helpers.ts";

// Chat agents run in a daemon the worker launches, so they outlive the worker process. These tests run
// the real `band-worker` binary, kill it, start it again on the same state dir and play the hub: they
// open the agent's channels with `acp.reattach` and acknowledge what they read. The agent is `cat`,
// which answers every line it is sent, or a shell that writes a lot of output.

interface Spawned {
  agentId: string;
  pid: number | null;
  stdio: number;
  stderr: number;
  held?: boolean;
}

interface Reattached extends Spawned {
  stdin: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads a channel in the background, counting what arrives. */
function reader(ch: Channel) {
  const chunks: Buffer[] = [];
  let ended = false;
  void (async () => {
    try {
      for await (const chunk of ch) chunks.push(chunk);
    } catch {
      // A reset ends the loop.
    }
    ended = true;
  })();
  return {
    text: () => Buffer.concat(chunks).toString(),
    bytes: () => chunks.reduce((n, c) => n + c.length, 0),
    ended: () => ended,
  };
}

describe("chat agents survive a worker restart", () => {
  let hub: TestHub;
  let root: string;
  let stateDir: string;
  let proc: WorkerProcess | null = null;
  let session: ServerSession;
  const pids = new Set<number>();

  hub = undefined as never;

  async function startWorker(env: NodeJS.ProcessEnv = {}): Promise<void> {
    const connected = hub.nextSession();
    proc = spawnWorkerProcess(
      ["--hub", hub.url, "--token", TOKEN, "--root", root, "--state-dir", stateDir],
      env,
    );
    session = await connected;
  }

  async function killWorker(): Promise<void> {
    const current = proc;
    assert.ok(current);
    current.child.kill("SIGKILL");
    await current.exited;
    proc = null;
  }

  const spawnAgent = async (command: string, args: string[], cwd = root) => {
    const reply = await session.request<Spawned>("acp.spawn", { command, args, env: {}, cwd });
    if (reply.pid) pids.add(reply.pid);
    return reply;
  };

  const attachTo = (reply: Spawned) => {
    const stdout = session.getChannel(reply.stdio) as Channel;
    const stderr = session.getChannel(reply.stderr) as Channel;
    assert.ok(stdout && stderr);
    return { stdout, out: reader(stdout), err: reader(stderr) };
  };

  before(async () => {
    hub = await startHub();
    root = tmpDir();
    stateDir = tmpDir("band-worker-state-");
    await startWorker({ BAND_AGENT_BUFFER_BYTES: "100000" });
  });

  after(async () => {
    if (proc) {
      proc.child.kill("SIGTERM");
      await proc.exited;
    }
    stopAgentDaemons(stateDir);
    await hub.close();
    await waitFor(
      () => [...pids].every((pid) => !isAlive(pid)),
      8000,
      "the agent processes to end",
    );
    cleanup(root, stateDir);
  });

  it("keeps the agent and its stdin across a restart, and continues the stream from an offset", async () => {
    const spawned = await spawnAgent("cat", []);
    assert.equal(spawned.held, true, "the agent runs in the daemon");
    const first = attachTo(spawned);
    await first.stdout.send(Buffer.from("one\n"));
    await waitFor(() => first.out.text() === "one\n", 8000, "the first echo");

    await killWorker();
    assert.ok(isAlive(spawned.pid as number), "the agent outlives the worker");
    await startWorker({ BAND_AGENT_BUFFER_BYTES: "100000" });

    // The hub has the 4 bytes it read. The daemon continues after them.
    const again = await session.request<Reattached>("acp.reattach", {
      agentId: spawned.agentId,
      stdout: 4,
      stderr: 0,
    });
    assert.equal(again.pid, spawned.pid, "the same process");
    assert.equal(again.stdin, 4, "the daemon says how many stdin bytes it has written");
    const second = attachTo(again);
    await second.stdout.send(Buffer.from("two\n"));
    await waitFor(() => second.out.text() === "two\n", 8000, "an echo after the restart");

    // Without an acknowledgement the daemon keeps everything, so a reader that was behind gets it again.
    const replay = await session.request<Reattached>("acp.reattach", {
      agentId: spawned.agentId,
      stdout: 0,
      stderr: 0,
    });
    const third = attachTo(replay);
    await waitFor(() => third.out.text() === "one\ntwo\n", 8000, "the replay from offset 0");
    third.stdout.reset();
    await call(session, "acp.kill", { agentId: spawned.agentId });
    await waitFor(() => !isAlive(spawned.pid as number), 8000, "the agent to stop on kill");
  });

  it("holds output above the cap and loses none of it", async () => {
    const total = 2_000_000;
    const spawned = await spawnAgent("sh", [
      "-c",
      `head -c ${total} /dev/zero | tr '\\0' x; sleep 30`,
    ]);
    // Nobody reads: drop the channels, then the worker itself.
    session.getChannel(spawned.stdio)?.reset();
    session.getChannel(spawned.stderr)?.reset();
    await killWorker();
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(isAlive(spawned.pid as number), "the agent is blocked, not dead");
    await startWorker({ BAND_AGENT_BUFFER_BYTES: "100000" });

    // The hub reads and acknowledges as it goes; the agent resumes each time the daemon has room.
    const again = await session.request<Reattached>("acp.reattach", {
      agentId: spawned.agentId,
      stdout: 0,
      stderr: 0,
    });
    const { out } = attachTo(again);
    let acked = 0;
    await waitFor(
      () => {
        const got = out.bytes();
        if (got > acked) {
          acked = got;
          void session.request("acp.ack", { agentId: spawned.agentId, stdout: got, stderr: 0 });
        }
        return got === total;
      },
      30_000,
      `all ${total} bytes (got ${out.bytes()})`,
    );
    assert.equal(out.bytes(), total);
    assert.ok(/^x+$/.test(out.text().slice(0, 1000)));
    await call(session, "acp.kill", { agentId: spawned.agentId });
  });

  it("reports an agent that exited while the worker was down, with its output", async () => {
    const spawned = await spawnAgent("sh", ["-c", "sleep 2; echo bye; exit 3"]);
    const exits: unknown[] = [];
    await killWorker();
    await waitFor(() => !isAlive(spawned.pid as number), 10_000, "the agent to exit by itself");
    await startWorker({ BAND_AGENT_BUFFER_BYTES: "100000" });
    session.onNotification("acp.exit", (p) => exits.push(p));

    const again = await session.request<Reattached>("acp.reattach", {
      agentId: spawned.agentId,
      stdout: 0,
      stderr: 0,
    });
    const { out } = attachTo(again);
    await waitFor(() => exits.length > 0, 8000, "the exit notification");
    assert.deepEqual(exits[0], { agentId: spawned.agentId, code: 3, signal: null });
    assert.equal(out.text(), "bye\n");
    await call(session, "acp.forget", { agentId: spawned.agentId });
    await assert.rejects(
      session.request("acp.reattach", { agentId: spawned.agentId, stdout: 0, stderr: 0 }),
      /no such agent/,
    );
  });

  it("refuses to reattach an agent it does not hold", async () => {
    await assert.rejects(
      session.request("acp.reattach", { agentId: "no-such-agent", stdout: 0, stderr: 0 }),
      /no such agent/,
    );
  });

  it("ends held agents the hub does not know, and keeps the ones it names", async () => {
    const keep = await spawnAgent("cat", []);
    const drop = await spawnAgent("cat", []);
    session.getChannel(keep.stdio)?.reset();
    session.getChannel(drop.stdio)?.reset();
    await call(session, "acp.reconcile", { keep: [keep.agentId] });
    await waitFor(() => !isAlive(drop.pid as number), 8000, "the unknown agent to end");
    assert.ok(isAlive(keep.pid as number));
    await call(session, "acp.kill", { agentId: keep.agentId });
  });

  it("kills a held agent in a folder another host owns, and refuses to start one there", async () => {
    const blocked = join(root, "moved");
    mkdirSync(blocked);
    const agent = await spawnAgent("cat", [], blocked);
    await session.request("lease.renew", { ttlMs: 60_000, blockedPaths: [blocked] });
    await waitFor(() => !isAlive(agent.pid as number), 5000, "the agent to be killed");
    await assert.rejects(spawnAgent("cat", [], blocked), /continued on another worker/);
    await session.request("lease.renew", { ttlMs: 60_000, blockedPaths: [] });
  });

  it("kills every held agent when the lease runs out, and refuses to start one until it is renewed", async () => {
    const agent = await spawnAgent("cat", []);
    await session.request("lease.renew", { ttlMs: 300, blockedPaths: [] });
    await waitFor(() => !isAlive(agent.pid as number), 5000, "the fence to kill the agent");
    await assert.rejects(spawnAgent("cat", []), /lost the hub's lease/);
    await session.request("lease.renew", { ttlMs: 60_000, blockedPaths: [] });
    const again = await spawnAgent("cat", []);
    await call(session, "acp.kill", { agentId: again.agentId });
  });

  it("kills held agents when the lease runs out while no worker is running", async () => {
    const agent = await spawnAgent("cat", []);
    await session.request("lease.renew", { ttlMs: 2500, blockedPaths: [] });
    await killWorker();
    // Nobody renews: the daemon enforces the lease itself.
    await waitFor(() => !isAlive(agent.pid as number), 12_000, "the daemon to end the agent");
    await startWorker({ BAND_AGENT_BUFFER_BYTES: "100000" });
    await assert
      .rejects(
        session.request("acp.reattach", { agentId: agent.agentId, stdout: 0, stderr: 0 }),
        /no such agent|exited/,
      )
      .catch(() => undefined);
  });

  it("keeps the daemon's socket and run dir private, in the worker's state dir", () => {
    const runDir = agentRunDir(stateDir);
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    const { socket } = agentDaemonPaths(runDir);
    assert.equal(statSync(socket).mode & 0o777, 0o600);
  });
});

describe("an agent nobody reattaches is killed (hub gone)", () => {
  let hub: TestHub;
  let root: string;
  let stateDir: string;
  let proc: WorkerProcess;
  let session: ServerSession;
  const pids = new Set<number>();

  before(async () => {
    hub = await startHub();
    root = tmpDir();
    stateDir = tmpDir("band-worker-state-");
    const connected = hub.nextSession();
    // The daemon reads the timeout from the environment the worker launched it with.
    proc = spawnWorkerProcess(
      ["--hub", hub.url, "--token", TOKEN, "--root", root, "--state-dir", stateDir],
      { BAND_AGENT_REATTACH_TIMEOUT_MS: "2000" },
    );
    session = await connected;
  });

  after(async () => {
    proc.child.kill("SIGTERM");
    await proc.exited;
    stopAgentDaemons(stateDir);
    await hub.close();
    await waitFor(() => [...pids].every((pid) => !isAlive(pid)), 8000, "the agents to end");
    cleanup(root, stateDir);
  });

  it("kills a held agent once the hub is gone and the reattach timeout has passed", async () => {
    const agent = await session.request<Spawned>("acp.spawn", {
      command: "cat",
      args: [],
      env: {},
      cwd: root,
    });
    pids.add(agent.pid as number);
    // The hub dies without a word: its link closes and the worker stays up and redials.
    await hub.close();
    assert.ok(isAlive(agent.pid as number), "the agent outlives the link for a while");
    await waitFor(
      () => !isAlive(agent.pid as number),
      15_000,
      "the daemon to kill the orphaned agent",
    );
  });
});
