// Retention and the size limit of checkpoints (default: keep the last 5; a checkpoint above the
// limit is skipped with a warning). A real hub and one real `band-worker` (see
// helpers/checkpoint-world.ts). The limit is lowered with `BAND_CHECKPOINT_MAX_BYTES` and the
// quiet-files trigger is pushed out of reach, so only the checkpoints the test takes exist.

import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";

interface TakeReply {
  status: "created" | "unchanged" | "skipped";
  reason?: string;
}

let w: World;
let a: Worker;
let wt = "";
let dir = "";

beforeAll(async () => {
  w = await startWorld({
    repos: [{ name: "proj" }],
    env: { BAND_CHECKPOINT_MAX_BYTES: "60000", BAND_CHECKPOINT_QUIET_MS: "3600000" },
  });
  a = await w.addWorker("a", ["proj"]);
  wt = await w.createWorktree(a, "proj", "feat-r");
  dir = w.worktreePath(a, "proj", "feat-r");
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("retention and the size limit (S7)", () => {
  it("keeps the last 5 checkpoints of a worktree", async () => {
    const taken: string[] = [];
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(dir, `v${i}.txt`), `version ${i}\n`);
      await w.m<TakeReply>("checkpoints.take", { worktreeId: wt });
      taken.push((await w.checkpoints(wt)).checkpoints[0]?.id as string);
    }
    const { checkpoints } = await w.checkpoints(wt);
    expect(checkpoints.map((c) => c.id)).toEqual(taken.slice(2).reverse());
    // The files of the two oldest are gone from the hub too.
    const onDisk = readdirSync(join(w.hubHome, ".band", "checkpoints", wt)).filter((n) =>
      n.startsWith("ckpt_"),
    );
    expect(onDisk.sort()).toEqual(taken.slice(2).sort());
  }, 120_000);

  it("skips a checkpoint above the size limit and says so", async () => {
    const before = (await w.checkpoints(wt)).checkpoints;
    writeFileSync(join(dir, "big.bin"), randomBytes(200_000));
    const skipped = await w.m<TakeReply>("checkpoints.take", { worktreeId: wt });
    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toMatch(/limit/);

    const after = await w.checkpoints(wt);
    expect(after.checkpoints.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after.warning).toMatch(/skipped/);

    // Once the file is gone the next checkpoint is taken and the warning clears.
    rmSync(join(dir, "big.bin"));
    writeFileSync(join(dir, "after-big.txt"), "small again\n");
    expect((await w.m<TakeReply>("checkpoints.take", { worktreeId: wt })).status).toBe("created");
    expect((await w.checkpoints(wt)).warning).toBeNull();
  }, 120_000);
});
