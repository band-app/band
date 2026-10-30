import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type LeaseRenewReply, METHOD_LEASE_RENEW, METHOD_PLUGIN_CALL } from "@band-app/link";
import {
  call,
  cleanup,
  makeRepo,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  waitFor,
} from "./helpers.ts";

function hasSimctl(): boolean {
  try {
    execFileSync("xcrun", ["simctl", "help"], { stdio: "ignore" });
    // Booting a device takes several minutes on a CI runner, and "Web Tests (macOS)" already runs
    // close to its 45 minute limit (this test pushed it over and the job was cancelled). The hub's
    // simulator test uses the same gate: it runs on a machine set up for simulators, which has idb.
    execFileSync("which", ["idb_companion"], { stdio: "ignore" });
    return process.platform === "darwin";
  } catch {
    return false;
  }
}

// The simulator plugin on a real worker whose lease runs out (the hub's side is a stand-in that stops
// renewing). A booted device is shut down by the fence, and a call is refused until the hub renews.
// Devices live in a device set under the worker's temp state dir, and the test deletes what it creates.
describe("simulator plugin and the lease fence", { skip: !hasSimctl() }, () => {
  let hub: TestHub;
  let w: TestWorker;
  let repo = "";

  const set = () => join(w.stateDir, "simulator", "devices");
  const devices = (): Array<{ udid: string; state: string }> => {
    if (!existsSync(set())) return [];
    const out = execFileSync("xcrun", ["simctl", "--set", set(), "list", "devices", "-j"], {
      encoding: "utf8",
    });
    return Object.values(
      (JSON.parse(out) as { devices: Record<string, Array<{ udid: string; state: string }>> })
        .devices,
    ).flat();
  };
  // A cold boot can take minutes on a CI runner. `RemoteHost` gives `plugin.call` five minutes
  // (`SLOW_CALLS` in packages/host-remote/src/rpc.ts), so the stand-in hub does the same.
  const rawStatus = () =>
    call<{ udid: string; state: string }>(
      w.session,
      METHOD_PLUGIN_CALL,
      {
        pluginId: "simulator",
        method: "screenshot",
        params: {},
        worktreeKey: "ws",
        worktreePath: repo,
      },
      { timeoutMs: 5 * 60_000 },
    );
  const dropped = (err: unknown) => /link dropped|link closed/i.test(String(err));
  // The stand-in hub heartbeats every second and gives up after three misses, so a loaded CI runner
  // can drop the link during a cold boot. The session resumes and the worker keeps booting, so a call
  // that met the drop is made again; the worker queues it behind the boot.
  const status = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawStatus();
      } catch (err) {
        if (!dropped(err) || attempt >= 10) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  const renew = (ttlMs: number) =>
    call<LeaseRenewReply>(w.session, METHOD_LEASE_RENEW, { ttlMs, blockedPaths: [] });

  before(async () => {
    hub = await startHub();
    w = await startWorker(hub);
    repo = makeRepo(w.root);
  });
  after(async () => {
    await w.worker.stop();
    if (existsSync(set())) {
      for (const cmd of ["shutdown", "delete"]) {
        try {
          execFileSync("xcrun", ["simctl", "--set", set(), cmd, "all"], { stdio: "ignore" });
        } catch {}
      }
    }
    await hub.close();
    cleanup(w.root, w.stateDir);
  });

  it("shuts the worktree's device down when the lease runs out and refuses calls until the hub renews", {
    // A CI runner boots a cold device in a minute or more, longer than the package's 90 s default.
    timeout: 8 * 60_000,
  }, async () => {
    await renew(120_000);
    await status();
    assert.equal(devices().filter((d) => d.state === "Booted").length, 1);

    // Stop renewing and let the lease run out: a short renewal makes it quick.
    await renew(1000);
    await waitFor(
      async () => devices().every((d) => d.state !== "Booted"),
      60_000,
      "the fence shuts the device down",
    );
    assert.equal(devices().length, 2, "the device and the base device are kept");
    // A slow runner can drop the link while the fence snapshots. The session resumes, and the
    // fence holds across the redial, so a call that met the drop is made again.
    let refusal = "";
    for (let attempt = 0; attempt < 20 && !refusal; attempt++) {
      try {
        await rawStatus();
        assert.fail("a fenced worker answered a plugin call");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (dropped(err)) await new Promise((r) => setTimeout(r, 1000));
        else refusal = message;
      }
    }
    assert.match(refusal, /lost the hub's lease/);

    const reply = await renew(60_000);
    assert.equal(reply.fenced, true);
  });
});
