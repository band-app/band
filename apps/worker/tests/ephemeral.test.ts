import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  call,
  cleanup,
  spawnWorkerProcess,
  startHub,
  type TestHub,
  TOKEN,
  tmpDir,
  type WorkerProcess,
} from "./helpers.ts";

const IDLE_MS = 1500;

// S5: an ephemeral worker exits with code 0 after the idle time, and not while a channel is open.
describe("ephemeral worker", () => {
  let hub: TestHub;
  const dirs: string[] = [];
  const procs: WorkerProcess[] = [];

  before(async () => {
    hub = await startHub();
  });
  after(async () => {
    for (const p of procs) p.child.kill("SIGKILL");
    await hub.close();
    cleanup(...dirs);
  });

  function launch(): WorkerProcess {
    const root = tmpDir();
    const stateDir = tmpDir("band-worker-state-");
    dirs.push(root, stateDir);
    const proc = spawnWorkerProcess([
      "--hub",
      hub.url,
      "--token",
      TOKEN,
      "--root",
      root,
      "--state-dir",
      stateDir,
      "--ephemeral",
      "--idle-exit",
      `${IDLE_MS}ms`,
    ]);
    procs.push(proc);
    return proc;
  }

  it("exits with code 0 once it has been idle for the idle time, and not before", async () => {
    const connected = hub.nextSession();
    const launchedAt = Date.now();
    const proc = launch();
    const session = await connected;
    assert.equal(session.hello.mode, "ephemeral");

    const early = await Promise.race([
      proc.exited,
      new Promise<"alive">((r) => setTimeout(() => r("alive"), IDLE_MS - 500)),
    ]);
    assert.equal(early, "alive", `exited before the idle time:\n${proc.output()}`);

    const { code, signal } = await proc.exited;
    assert.equal(signal, null);
    assert.equal(code, 0, proc.output());
    assert.ok(Date.now() - launchedAt >= IDLE_MS - 100, "waited out the idle time");
  });

  it("stays up while a channel is open, then exits after it closes", async () => {
    const connected = hub.nextSession();
    const proc = launch();
    const session = await connected;
    const root = session.hello.roots[0] as string;

    await call(session, "pty.spawn", { worktreeId: "ws", terminalId: "t", worktreeRoot: root });
    const { chan } = (await session.request("pty.attach", {
      terminalId: "t",
      killOnClose: true,
    })) as { chan: number };
    const ch = session.getChannel(chan);
    assert.ok(ch);

    const during = await Promise.race([
      proc.exited,
      new Promise<"alive">((r) => setTimeout(() => r("alive"), IDLE_MS * 2.5)),
    ]);
    assert.equal(during, "alive", `exited with a channel open:\n${proc.output()}`);

    const closedAt = Date.now();
    ch.reset();
    const { code } = await proc.exited;
    assert.equal(code, 0, proc.output());
    assert.ok(
      Date.now() - closedAt >= IDLE_MS - 100,
      "the idle clock started when the channel closed",
    );
  });

  it("counts a call in progress as activity", async () => {
    const connected = hub.nextSession();
    const proc = launch();
    const session = await connected;
    // A command that outlasts the idle time keeps the worker up until it answers.
    const start = Date.now();
    await call(session, "exec", {
      bin: process.execPath,
      args: ["-e", `setTimeout(() => {}, ${IDLE_MS * 2})`],
    });
    assert.ok(Date.now() - start >= IDLE_MS * 2 - 100);
    assert.equal(
      await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("alive"), 300))]),
      "alive",
    );
    const { code } = await proc.exited;
    assert.equal(code, 0);
  });
});
