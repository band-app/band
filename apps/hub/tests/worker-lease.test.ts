// Issue #901: the hub renews each worker's lease while its link is up, and offers "Open on
// another host" for an offline worker's worktree only after that lease is over. A copy that was
// continued elsewhere stays stopped when its worker returns. Real hub, real `band-worker`
// processes (helpers/checkpoint-world.ts), whose lease is LEASE_MS.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, LEASE_MS, startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { waitFor } from "./helpers/wait-for";

interface Offer {
  blocked?: { reason: string; message: string };
  leaseExpiresAt?: number;
  targets: Array<{ hostId: string }>;
}

let w: World;
let a: Worker;
let b: Worker;
let aId = "";

const offer = () => w.q<Offer>("follow.offer", { worktreeId: aId });

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  a = await w.addWorker("a", ["proj"]);
  b = await w.addWorker("b", ["proj"]);
  await w.createWorktree(b, "proj", "seed-b");
  aId = await w.createWorktree(a, "proj", "feat-lease");
  await w.m("checkpoints.take", { worktreeId: aId });
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("the old owner's lease", () => {
  it("holds back Open on another worker until the offline worker's lease is over", async () => {
    const killedAt = Date.now();
    await w.killWorker(a, "SIGKILL", { waitForLease: false });

    const early = await offer();
    expect(early.blocked?.reason).toBe("lease-active");
    expect(early.leaseExpiresAt).toBeGreaterThan(Date.now());
    expect(early.leaseExpiresAt).toBeLessThanOrEqual(killedAt + LEASE_MS + 5_000);
    expect(early.blocked?.message).toContain("may still be running");

    // The API enforces it too, not only the offer.
    const refused = await w.mFail("checkpoints.restore", { worktreeId: aId, toHostId: b.hostId });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body).toContain("lease ends");
    const refusedContinue = await w.mFail("follow.continue", {
      worktreeId: aId,
      toHostId: b.hostId,
    });
    expect(refusedContinue.status).toBeGreaterThanOrEqual(400);

    // Once the lease is over the offer opens up, with B as the target.
    await waitFor(async () => ((await offer()).blocked === undefined ? true : undefined), {
      label: "the lease to end",
      timeoutMs: 15_000,
    });
    expect((await offer()).targets.map((t) => t.hostId)).toEqual([b.hostId]);
  }, 60_000);

  it("keeps the superseded copy stopped when its worker comes back", async () => {
    await waitFor(async () => ((await offer()).blocked === undefined ? true : undefined), {
      label: "the lease to end",
      timeoutMs: 15_000,
    });
    const result = await w.m<{ worktreeId: string }>("follow.continue", {
      worktreeId: aId,
      toHostId: b.hostId,
    });
    expect(result.worktreeId).toBe(`proj-feat-lease@${b.hostId}`);

    a = await w.restartWorker(a);

    // The hub tells the returning worker which folders another host owns on its first renewal.
    await waitFor(
      async () => {
        const res = await w.mFail("terminal.create", { worktreeId: aId, id: randomUUID() });
        return res.status >= 400 && res.body.includes("continued on another worker")
          ? true
          : undefined;
      },
      { label: "the old copy to stay closed", timeoutMs: 20_000 },
    );

    // The new copy on B runs as usual.
    const newTerminal = randomUUID();
    const created = await w.m<{ terminalId: string }>("terminal.create", {
      worktreeId: result.worktreeId,
      id: newTerminal,
    });
    expect(created.terminalId).toBe(newTerminal);
    expect(git(w.worktreePath(b, "proj", "feat-lease"), "branch", "--show-current").trim()).toBe(
      "feat-lease",
    );
  }, 90_000);
});
