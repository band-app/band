import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HostOfflineError, HostPathDeniedError, HostTimeoutError } from "@band-app/host-api";
import { RemoteHost } from "@band-app/host-remote";
import {
  cleanup,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  tmpDir,
} from "./helpers.ts";

// What RemoteHost does that LocalHost never needs to: map the worker's
// refusals to host errors, fail cleanly when the link is down, and move data
// larger than one link message (plan step 2.3).
describe("RemoteHost errors and limits", () => {
  let hub: TestHub;
  let w: TestWorker;
  let host: RemoteHost;
  let outside: string;

  before(async () => {
    hub = await startHub();
    let workerId = "";
    host = new RemoteHost({
      id: "remote-errors",
      session: () => hub.server.getSession(workerId),
      defaultTimeoutMs: 400,
    });
    hub.server.on("session", (session) => host.attachSession(session));
    w = await startWorker(hub);
    workerId = w.worker.workerId;
    outside = tmpDir("band-remote-outside-");
    await symlink(outside, join(w.root, "escape"));
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir, outside);
  });

  it("rejects a path outside the worker's roots with HostPathDeniedError", async () => {
    await assert.rejects(host.fs.readFile(join(outside, "x.txt")), (err: unknown) => {
      assert.ok(err instanceof HostPathDeniedError);
      assert.equal(err.path, join(outside, "x.txt"));
      return true;
    });
    // A symlink inside the root that leads out is refused too.
    await assert.rejects(host.fs.list(join(w.root, "escape")), HostPathDeniedError);
    await assert.rejects(host.fs.writeFile("relative.txt", "x"), HostPathDeniedError);
  });

  it("keeps the errno code of a failure on the worker", async () => {
    await assert.rejects(host.fs.stat(join(w.root, "missing")), (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  });

  it("writes and reads a file larger than one link message", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, "band");
    const path = join(w.root, "big.bin");
    await host.fs.writeFile(path, big);
    const back = await host.fs.readFile(path);
    assert.equal(back.byteLength, big.byteLength);
    assert.ok(Buffer.from(back).equals(big));
    assert.equal((await host.fs.stat(path)).size, big.byteLength);
  });

  it("writes into a directory it just made, on the worker", async () => {
    const dir = join(w.root, "made", "deep");
    await host.fs.mkdir(dir, { recursive: true });
    await mkdir(join(w.root, "made", "other"));
    await host.fs.writeFile(join(dir, "a.txt"), "x");
    assert.deepEqual(
      (await host.fs.list(dir)).map((e) => e.name),
      ["a.txt"],
    );
  });

  it("times out a call the worker does not answer", async () => {
    // Opening a FIFO for reading blocks until something opens it for writing.
    const fifo = join(w.root, "blocked");
    execFileSync("mkfifo", [fifo]);
    await assert.rejects(host.fs.readFile(fifo), HostTimeoutError);
    // Release the worker's blocked read, so it can shut down.
    writeFileSync(fifo, "");
  });

  it("rejects with HostOfflineError once the worker is gone", async () => {
    await w.worker.stop();
    await assert.rejects(host.info(), HostOfflineError);
    await assert.rejects(host.git.exec(["status"], w.root), HostOfflineError);
    // Fire-and-forget terminal calls do not throw on an offline host.
    host.pty.input("t", "x");
    host.pty.resize("t", 80, 24);
  });
});
