import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  cleanup,
  spawnWorkerProcess,
  startHub,
  startWorker,
  type TestHub,
  tmpDir,
  waitFor,
} from "./helpers.ts";

const BOOTSTRAP = "bst_one-time-bootstrap-secret";

// S6: the bootstrap exchange, and the session token file that results.
describe("session token", () => {
  let hub: TestHub;
  const dirs: string[] = [];

  before(async () => {
    hub = await startHub({ bootstrapTokens: [BOOTSTRAP] });
  });
  after(async () => {
    await hub.close();
    cleanup(...dirs);
  });

  function scratch(): { root: string; stateDir: string } {
    const root = tmpDir();
    const stateDir = tmpDir("band-worker-state-");
    dirs.push(root, stateDir);
    return { root, stateDir };
  }

  it("trades the bootstrap token once and stores the session token with mode 0600", async () => {
    const { root, stateDir } = scratch();
    const w = await startWorker(hub, { root, stateDir, token: BOOTSTRAP });
    try {
      assert.deepEqual(
        hub.bootstraps.filter((b) => b.workerId === w.worker.workerId),
        [{ token: BOOTSTRAP, workerId: w.worker.workerId }],
      );
      const file = join(stateDir, "session-token");
      await waitFor(() => readFileSync(file, "utf8").trim() === `sess-${w.worker.workerId}`);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(stateDir).mode & 0o777, 0o700);
      assert.equal(statSync(join(stateDir, "worker-id")).mode & 0o777, 0o600);
      assert.deepEqual(
        readdirSync(stateDir).filter((f) => f.endsWith(".tmp")),
        [],
      );
    } finally {
      await w.worker.stop();
    }
  });

  it("reuses the stored session token on a restart without asking the hub again", async () => {
    const { root, stateDir } = scratch();
    const first = await startWorker(hub, { root, stateDir, token: BOOTSTRAP });
    const id = first.worker.workerId;
    await first.worker.stop();
    const second = await startWorker(hub, { root, stateDir, token: BOOTSTRAP });
    try {
      assert.equal(second.worker.workerId, id);
      assert.equal(hub.bootstraps.filter((b) => b.workerId === id).length, 1);
    } finally {
      await second.worker.stop();
    }
  });

  it("never writes a token to its output", async () => {
    const { root, stateDir } = scratch();
    const connected = hub.nextSession();
    const proc = spawnWorkerProcess([
      "--hub",
      hub.url,
      "--token",
      BOOTSTRAP,
      "--root",
      root,
      "--state-dir",
      stateDir,
    ]);
    const session = await connected;
    const file = join(stateDir, "session-token");
    const sessionToken = `sess-${session.workerId}`;
    await waitFor(() => statSync(file, { throwIfNoEntry: false }) !== undefined);
    assert.equal(readFileSync(file, "utf8").trim(), sessionToken);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    proc.child.kill("SIGTERM");
    const { code } = await proc.exited;
    assert.equal(code, 0, proc.output());
    const output = proc.output();
    assert.ok(output.includes("connected to the hub"), "the debug log ran");
    for (const secret of [BOOTSTRAP, sessionToken]) {
      assert.ok(!output.includes(secret), `output leaked ${secret}`);
    }
  });

  it("exits 1 without echoing the token when the hub refuses the bootstrap token", async () => {
    const { root, stateDir } = scratch();
    const proc = spawnWorkerProcess([
      "--hub",
      hub.url,
      "--token",
      "bst_wrong-secret",
      "--root",
      root,
      "--state-dir",
      stateDir,
    ]);
    const { code } = await proc.exited;
    assert.equal(code, 1);
    assert.match(proc.output(), /refused the bootstrap token \(HTTP 401\)/);
    assert.ok(!proc.output().includes("bst_wrong-secret"));
  });
});
