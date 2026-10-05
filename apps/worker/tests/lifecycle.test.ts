import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type LifecycleIdleParams,
  METHOD_LIFECYCLE_IDLE,
  METHOD_LIFECYCLE_POLICY,
  type SessionFile,
} from "@band-app/link";
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

// Plan step 3.5: an ephemeral worker asks the hub before it exits, takes the idle time the hub
// sets, and reads and restores agent session files for the hub.
describe("ephemeral lifecycle", () => {
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

  function launch(idle: string, env: NodeJS.ProcessEnv = {}): WorkerProcess {
    const root = tmpDir();
    const stateDir = tmpDir("band-worker-state-");
    dirs.push(root, stateDir);
    const proc = spawnWorkerProcess(
      [
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
        idle,
      ],
      env,
    );
    procs.push(proc);
    return proc;
  }

  it("exits only when the hub answers exit: true, and asks again after a refusal", async () => {
    const connected = hub.nextSession();
    const proc = launch("600ms");
    const session = await connected;
    const asked: number[] = [];
    session.handle(METHOD_LIFECYCLE_IDLE, (params) => {
      const { idleMs } = params as LifecycleIdleParams;
      assert.ok(idleMs >= 500, `asked after ${idleMs} ms of idle time`);
      asked.push(Date.now());
      return asked.length === 1 ? { exit: false, reason: "a terminal is running" } : { exit: true };
    });

    const { code, signal } = await proc.exited;
    assert.equal(signal, null);
    assert.equal(code, 0, proc.output());
    assert.equal(asked.length, 2, "asked once, was refused, asked again after another idle time");
    assert.ok((asked[1] as number) - (asked[0] as number) >= 500, "waited out the idle time again");
    assert.match(proc.output(), /a terminal is running/);
  });

  it("stays up while the hub keeps refusing", async () => {
    const connected = hub.nextSession();
    const proc = launch("300ms");
    const session = await connected;
    let asked = 0;
    session.handle(METHOD_LIFECYCLE_IDLE, () => {
      asked++;
      return { exit: false, reason: "not yet" };
    });
    const state = await Promise.race([
      proc.exited,
      new Promise<"alive">((r) => setTimeout(() => r("alive"), 1800)),
    ]);
    assert.equal(state, "alive", proc.output());
    assert.ok(asked >= 2, `asked ${asked} times`);
    proc.child.kill("SIGKILL");
  });

  it("uses the idle time the hub sends", async () => {
    const connected = hub.nextSession();
    const proc = launch("1h");
    const session = await connected;
    let askedAt = 0;
    session.handle(METHOD_LIFECYCLE_IDLE, () => {
      askedAt = Date.now();
      return { exit: true };
    });
    const sentAt = Date.now();
    await session.request(METHOD_LIFECYCLE_POLICY, { idleExitMs: 400 });
    const { code } = await proc.exited;
    assert.equal(code, 0, proc.output());
    assert.ok(askedAt - sentAt < 5000, "asked long before the 1h it was started with");
  });

  it("is not kept awake by the hub's polling reads", async () => {
    const connected = hub.nextSession();
    const proc = launch("700ms");
    const session = await connected;
    let asked = false;
    session.handle(METHOD_LIFECYCLE_IDLE, () => {
      asked = true;
      return { exit: true };
    });
    // A status poller and the repo list read the worker every 100 ms.
    let exited = false;
    void proc.exited.then(() => {
      exited = true;
    });
    const deadline = Date.now() + 8000;
    while (!exited && Date.now() < deadline) {
      await call(session, "host.info").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(asked, true, "asked to exit while being polled");
    const { code } = await proc.exited;
    assert.equal(code, 0, proc.output());
  });

  it("reads a session's files and puts staged files back", async () => {
    const sessionsDir = tmpDir("band-agent-sessions-");
    dirs.push(sessionsDir);
    writeFileSync(join(sessionsDir, "abc-123.json"), '{"history":["hi"]}');
    writeFileSync(join(sessionsDir, "other-999.json"), "{}");
    const connected = hub.nextSession();
    const proc = launch("1h", { BAND_AGENT_SESSION_DIRS: sessionsDir });
    const session = await connected;
    const root = session.hello.roots[0] as string;

    const { files } = await call<{ files: SessionFile[] }>(session, "lifecycle.exportSessions", {
      sessionIds: ["abc-123"],
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.root, "extra0");
    assert.equal(files[0]?.rel, "abc-123.json");
    assert.equal(Buffer.from(files[0]?.data ?? "", "base64").toString(), '{"history":["hi"]}');

    // A fresh machine: the staged copy arrives through ordinary file calls.
    const stage = join(root, ".band-wip", "sessions", "ws");
    mkdirSync(join(stage, "extra0"), { recursive: true });
    writeFileSync(join(stage, "extra0", "restored-1.json"), '{"history":["back"]}');
    const { moved } = await call<{ moved: number }>(session, "lifecycle.importSessions", {
      dir: stage,
    });
    assert.equal(moved, 1);
    assert.equal(
      readFileSync(join(sessionsDir, "restored-1.json"), "utf8"),
      '{"history":["back"]}',
    );
    assert.equal(existsSync(stage), false, "the staging directory is removed");
    proc.child.kill("SIGKILL");
  });
});
