// The hub pushes a host's blocked folders when they change, instead of waiting for the next timed
// lease renewal. The lease is 2 minutes here, so the timer (every 24 s) cannot explain a result
// within a few seconds. Real hub, real `band-worker` processes (helpers/checkpoint-world.ts).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { waitFor } from "./helpers/wait-for";

let w: World;
let a: Worker;
let b: Worker;

const refusal = async (worktreeId: string) => {
  const res = await w.mFail("terminal.create", { worktreeId, id: randomUUID() });
  return res.status >= 400 && res.body.includes("continued on another worker");
};
const startsOn = async (worktreeId: string) => {
  const id = randomUUID();
  const created = await w.m<{ terminalId: string }>("terminal.create", { worktreeId, id });
  expect(created.terminalId).toBe(id);
};

beforeAll(async () => {
  w = await startWorld({
    repos: [{ name: "proj" }],
    env: { BAND_WORKER_LEASE_MS: "120000" },
  });
  a = await w.addWorker("a", ["proj"]);
  b = await w.addWorker("b", ["proj"]);
  await w.createWorktree(b, "proj", "seed-b");
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("blocked folders are pushed on change", () => {
  it("refuses work on the old copy at once, and allows it again after a move back", async () => {
    const onA = await w.createWorktree(a, "proj", "feat-push");
    await w.m("checkpoints.take", { worktreeId: onA });
    await startsOn(onA);

    const toB = await w.m<{ worktreeId: string }>("checkpoints.restore", {
      worktreeId: onA,
      toHostId: b.hostId,
    });
    // A is online and its lease is long: only the push can have told it.
    await waitFor(async () => ((await refusal(onA)) ? true : undefined), {
      label: "A to refuse the superseded copy",
      timeoutMs: 3_000,
    });

    await w.m("checkpoints.take", { worktreeId: toB.worktreeId });
    await w.m("checkpoints.restore", { worktreeId: toB.worktreeId, toHostId: a.hostId });
    // The very next start on A runs, with no wait for the timer.
    await startsOn(onA);
  }, 120_000);
});

describe("discarding the old default-branch copy", () => {
  it("lets work start in its folder right away", async () => {
    // A lease of 6 s renews every 1.2 s. Offline continuation has to wait the lease out, so this
    // world cannot use the 2 minute one. A start right after discardOld is told within ms, while
    // the timer would take up to 1.2 s.
    const world = await startWorld({
      repos: [{ name: "proj" }],
      env: { BAND_WORKER_LEASE_MS: "6000" },
    });
    try {
      let wa = await world.addWorker("a", ["proj"]);
      const wb = await world.addWorker("b", ["proj"]);
      for (const worker of [wa, wb]) {
        await world.m("repos.addFromWorker", {
          hostId: worker.hostId,
          path: join(worker.root, "proj"),
        });
      }
      const mainA = `proj-main@${wa.hostId}`;
      await world.m("checkpoints.take", { worktreeId: mainA });
      await world.killWorker(wa);
      const offerFor = () =>
        world.q<{ blocked?: { reason: string } }>("follow.offer", { worktreeId: mainA });
      await waitFor(async () => ((await offerFor()).blocked === undefined ? true : undefined), {
        label: "the lease to end",
        timeoutMs: 15_000,
      });
      await world.m("follow.continue", { worktreeId: mainA, toHostId: wb.hostId });
      wa = await world.restartWorker(wa);
      await waitFor(
        async () => {
          const res = await world.mFail("terminal.create", { worktreeId: mainA, id: randomUUID() });
          return res.status >= 400 && res.body.includes("continued on another worker")
            ? true
            : undefined;
        },
        { label: "A to refuse its main", timeoutMs: 20_000 },
      );

      await world.m("follow.discardOld", {
        worktreeId: mainA,
        confirm: true,
        discardChanges: true,
      });
      const id = randomUUID();
      const created = await world.m<{ terminalId: string }>("terminal.create", {
        worktreeId: mainA,
        id,
      });
      expect(created.terminalId).toBe(id);
    } finally {
      await world.close();
    }
  }, 180_000);
});
