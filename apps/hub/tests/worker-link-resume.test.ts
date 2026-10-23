// Issue #994: after the link between a worker and the hub drops, any number of times and at any
// moment, the worker is back online within seconds and hub-routed calls work again. Real hub, real
// `band-worker` dialing through a proxy the test cuts several times in quick succession.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { type CuttableProxy, startCuttableProxy } from "./helpers/cuttable-proxy";
import { waitFor } from "./helpers/wait-for";

let w: World;
let proxy: CuttableProxy;
let worker: Worker;
let wt = "";

const hostStatus = async () =>
  (await w.q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
    (h) => h.id === worker.hostId,
  )?.status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  proxy = await startCuttableProxy(w.server.url);
  worker = await w.addWorker("flaky", ["proj"], {
    hubUrl: proxy.url,
    // Log a repeating failure every second instead of every minute, so the test can read it.
    env: { BAND_WORKER_LINK_LOG_MS: "1000" },
  });
  wt = await w.createWorktree(worker, "proj", "feat-link");
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await w?.close();
});

describe("repeated link cuts (S1, S2)", () => {
  it("brings the worker back online and serves hub-routed calls after quick cuts", async () => {
    for (let i = 0; i < 12; i++) {
      await proxy.cut();
      await sleep(20 + (i % 4) * 40);
      await proxy.restore();
      // Long enough for the hub to start reading host.info and renew the lease, short enough to
      // cut it mid-call.
      await sleep(30 + ((i * 53) % 250));
    }
    await waitFor(async () => ((await hostStatus()) === "online" ? true : undefined), {
      label: "the worker online after the last cut",
      timeoutMs: 15_000,
    });
    const files = await w.q<unknown>("worktree.listFiles", { worktreeId: wt, path: "" });
    expect(files).toBeTruthy();
  }, 90_000);

  it("logs why it cannot reach the hub, backs off, and reconnects when the hub is back (S4)", async () => {
    await waitFor(async () => ((await hostStatus()) === "online" ? true : undefined), {
      label: "online",
      timeoutMs: 15_000,
    });
    // The backoff starts over once a link has stayed up for 10 s.
    await sleep(11_000);
    const before = worker.output().length;
    await proxy.cut();
    await sleep(7_000);
    const during = worker.output().slice(before);
    const failures = during
      .split("\n")
      .filter((l) => l.includes("could not reach the hub, will retry"));
    // Named reason, throttled to the 1 s interval rather than one line per redial.
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.length).toBeLessThanOrEqual(8);
    expect(failures[0]).toContain("ECONNREFUSED");

    await proxy.restore();
    // One backoff step: the cap is 15 s plus up to 25% jitter.
    await waitFor(async () => ((await hostStatus()) === "online" ? true : undefined), {
      label: "the worker online after the hub returned",
      timeoutMs: 20_000,
    });
    const files = await w.q<unknown>("worktree.listFiles", { worktreeId: wt, path: "" });
    expect(files).toBeTruthy();
  }, 90_000);
});
