import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type LeaseRenewReply, METHOD_LEASE_RENEW } from "@band-app/link";
import {
  call,
  cleanup,
  git,
  makeRepo,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  waitFor,
} from "./helpers.ts";

// Issue #901: the hub grants a lease and renews it while the link is up. A worker whose lease runs
// out snapshots its worktrees locally, then stops its terminals, and starts nothing until the hub
// renews. A folder the hub says another host owns stays closed even after the renewal.
describe("lease and fencing", () => {
  let hub: TestHub;
  let w: TestWorker;
  let repo = "";

  const renew = (ttlMs: number, blockedPaths: string[] = []) =>
    call<LeaseRenewReply>(w.session, METHOD_LEASE_RENEW, { ttlMs, blockedPaths });
  const spawn = (id: string, worktreeRoot = repo) =>
    call<{ pid: number }>(w.session, "pty.spawn", {
      worktreeId: "ws",
      terminalId: id,
      worktreeRoot,
    });
  const terminals = () => call<Array<{ terminalId: string }>>(w.session, "pty.listAll", {});

  before(async () => {
    hub = await startHub();
    w = await startWorker(hub);
    repo = makeRepo(w.root);
    writeFileSync(join(repo, "work.txt"), "work in progress\n");
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir);
  });

  it("stops terminals when the lease runs out, then keeps the work in a local snapshot", async () => {
    assert.deepEqual(await renew(1000), { fenced: false, snapshots: 0 });
    await spawn("t1");
    assert.equal((await terminals()).length, 1);

    // No more renewals: the lease runs out.
    await waitFor(async () => (await terminals()).length === 0, 8000, "the fence stops terminals");

    // The snapshot is built after the stop, so it is written a moment later.
    await waitFor(async () => existsSync(join(w.stateDir, "fenced.json")), 8000, "the snapshot");
    await assert.rejects(spawn("t2"), /lost the hub's lease/);

    // The files stay, and a snapshot commit holds them under a local ref.
    assert.equal(readFileSync(join(repo, "work.txt"), "utf8"), "work in progress\n");
    const refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/band/fenced").trim();
    assert.ok(refs.length > 0, "a fenced snapshot ref exists");
    assert.equal(git(repo, "show", `${refs.split("\n")[0]}:work.txt`), "work in progress\n");
    assert.ok(existsSync(join(w.stateDir, "fenced.json")));
    // Nothing was uploaded or committed on the branch.
    assert.equal(git(repo, "status", "--porcelain").trim(), "?? work.txt");
  });

  it("refuses a renewal without a positive ttlMs", async () => {
    for (const ttlMs of [0, -5, Number.NaN]) {
      await assert.rejects(renew(ttlMs), /positive ttlMs/);
    }
  });

  it("starts again after the hub renews, and reports that it had fenced", async () => {
    const reply = await renew(60_000);
    assert.equal(reply.fenced, true);
    assert.ok(reply.snapshots >= 1);
    await spawn("t3");
    assert.equal((await terminals()).length, 1);
  });

  it("starts nothing in a folder another host owns, even with a live lease", async () => {
    await renew(60_000, [repo]);
    await assert.rejects(spawn("t4"), /continued on another host/);
    await renew(60_000, []);
    await spawn("t5");
  });
});
