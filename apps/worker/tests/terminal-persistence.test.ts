import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { daemonPaths } from "@band-app/host-local/terminals/daemon/protocol";
import type { Channel, ServerSession } from "@band-app/link";
import { stopTerminalDaemons, terminalRunDir } from "../src/terminals.ts";
import {
  call,
  cleanup,
  decode,
  spawnWorkerProcess,
  startHub,
  type TestHub,
  TOKEN,
  tmpDir,
  type WorkerProcess,
  waitFor,
} from "./helpers.ts";

// Terminals run in a daemon the worker launches, so they outlive the worker process. These tests run the
// real `band-worker` binary, kill it, start it again on the same state dir and look at what the hub sees.

interface Entry {
  terminalId: string;
  pid: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonPids(stateDir: string): number[] {
  const runDir = terminalRunDir(stateDir);
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((name) => /^terminal-daemon-v\d+\.pid$/.test(name))
    .map((name) => (JSON.parse(readFileSync(join(runDir, name), "utf8")) as { pid: number }).pid);
}

async function attach(session: ServerSession, terminalId: string) {
  const res = (await session.request("pty.attach", {
    terminalId,
    dims: { cols: 80, rows: 24 },
  })) as { chan: number; snapshot: Parameters<typeof decode>[1] };
  const ch = session.getChannel(res.chan) as Channel;
  assert.ok(ch);
  let text = "";
  void (async () => {
    try {
      for await (const chunk of ch) text += chunk.toString();
    } catch {
      // A reset ends the loop.
    }
  })();
  return { ch, snapshot: (await decode(session, res.snapshot)) as string, text: () => text };
}

describe("terminals survive a worker restart", () => {
  let hub: TestHub;
  let root: string;
  let stateDir: string;
  let proc: WorkerProcess | null = null;
  let session: ServerSession;
  const exits: { terminalId: string; exitCode: number; killed: boolean }[] = [];
  const pids = new Set<number>();

  hub = undefined as never;

  async function startWorker(): Promise<void> {
    const connected = hub.nextSession();
    proc = spawnWorkerProcess([
      "--hub",
      hub.url,
      "--token",
      TOKEN,
      "--root",
      root,
      "--state-dir",
      stateDir,
    ]);
    session = await connected;
  }

  async function killWorker(): Promise<void> {
    const current = proc;
    assert.ok(current);
    current.child.kill("SIGKILL");
    await current.exited;
    proc = null;
  }

  const spawnTerminal = (terminalId: string, command?: string) =>
    call<Entry>(session, "pty.spawn", {
      worktreeId: "ws",
      terminalId,
      worktreeRoot: root,
      options: command ? { command } : undefined,
    });

  before(async () => {
    hub = await startHub();
    root = tmpDir();
    stateDir = tmpDir("band-worker-state-");
    hub.server.on("connected", (s: ServerSession) =>
      s.onNotification("pty.exit", (p) => exits.push(p as (typeof exits)[number])),
    );
    await startWorker();
  });

  after(async () => {
    if (proc) {
      proc.child.kill("SIGTERM");
      await proc.exited;
    }
    stopTerminalDaemons(stateDir);
    await hub.close();
    // Nothing may be left running: the daemon and every shell it held.
    await waitFor(
      () => [...pids].every((pid) => !isAlive(pid)),
      8000,
      "the terminal processes to end",
    );
    cleanup(root, stateDir);
  });

  // S1
  it("keeps the shell, its scrollback and its input across a restart", async () => {
    const before = await spawnTerminal("t1");
    pids.add(before.pid);
    for (const pid of daemonPids(stateDir)) pids.add(pid);
    assert.equal(daemonPids(stateDir).length, 1, "the worker started one terminal daemon");

    const first = await attach(session, "t1");
    await first.ch.send(Buffer.from("echo earlier-$((6*7))\n"));
    await waitFor(() => first.text().includes("earlier-42"), 8000, "first output");
    first.ch.reset();

    await killWorker();
    assert.ok(isAlive(before.pid), "the shell outlives the worker");
    await startWorker();

    const listed = await call<Entry[]>(session, "pty.listAll");
    const same = listed.find((entry) => entry.terminalId === "t1");
    assert.ok(same, "the terminal is listed with the same id");
    assert.equal(same.pid, before.pid, "it is the same process");

    const second = await attach(session, "t1");
    assert.match(second.snapshot, /earlier-42/, "the scrollback shows the earlier output");
    await second.ch.send(Buffer.from("echo later-$((6*7)) pid=$$\n"));
    await waitFor(() => second.text().includes("later-42"), 8000, "input after the restart");
    assert.ok(second.text().includes(`pid=${before.pid}`), "the same shell answered");
    second.ch.reset();
  });

  // S2
  it("reports a shell that exited while the worker was down, with its exit code", async () => {
    const entry = await spawnTerminal("t2", "sleep 2; exit 7");
    pids.add(entry.pid);
    await killWorker();
    await waitFor(() => !isAlive(entry.pid), 10_000, "the shell to exit while the worker is down");
    exits.length = 0;
    await startWorker();

    await waitFor(() => exits.some((e) => e.terminalId === "t2"), 8000, "the exit report");
    const exit = exits.find((e) => e.terminalId === "t2");
    assert.equal(exit?.exitCode, 7);
    assert.equal(exit?.killed, false);
    const listed = await call<Entry[]>(session, "pty.listAll");
    assert.ok(!listed.some((e) => e.terminalId === "t2"));
    assert.ok(
      listed.some((e) => e.terminalId === "t1"),
      "the other terminal is still there",
    );
  });

  // S4
  it("keeps the daemon's socket and run dir private, in the worker's state dir", () => {
    const runDir = terminalRunDir(stateDir);
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    // Under the state dir, unless that path is too long for a Unix socket: then a private dir in /tmp.
    const { socket } = daemonPaths(runDir);
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(socket)).mode & 0o777, 0o700);
    const token = readdirSync(runDir).find((name) => name.endsWith(".token")) as string;
    assert.equal(statSync(join(runDir, token)).mode & 0o777, 0o600);
  });

  // S3
  it("ends the shell when the terminal is closed, and the daemon when the last one goes", async () => {
    const [daemon] = daemonPids(stateDir);
    assert.ok(daemon && isAlive(daemon));
    const info = await call<Entry>(session, "pty.info", { terminalId: "t1" });
    await call(session, "pty.kill", { terminalId: "t1" });
    await waitFor(() => !isAlive(info.pid), 8000, "the shell to end");
    assert.equal(await call(session, "pty.info", { terminalId: "t1" }), null);

    await killWorker();
    await waitFor(() => !isAlive(daemon), 8000, "the daemon to exit with no shells and no worker");
  });
});
