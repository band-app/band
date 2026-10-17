// Issue #901: opening a worktree on a host that already holds a copy of it. The checkpoint wins:
// the target ends with the checkpoint's tree, and what it held is kept under
// `refs/band/backup/<worktree id>/<time>`. The default branch is the target's own checkout of the
// repo and is replaced the same way. Discarding the superseded default-branch copy resets it to
// the latest remote branch instead of removing the folder. Real hub, real workers.

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { git, startWorld, type Worker, type World } from "./helpers/checkpoint-world";

interface Worktree {
  name: string;
  path: string;
  hostId?: string;
  supersededBy?: string;
  continuedFrom?: { fromHostId: string };
}
interface ContinueReply {
  worktreeId: string;
}

let w: World;
let a: Worker;
let b: Worker;

const rows = async (name: string) =>
  (await w.q<{ repos: Array<{ name: string; worktrees: Worktree[] }> }>("repos.list")).repos
    .find((r) => r.name === "proj")
    ?.worktrees.filter((x) => x.name === name) ?? [];
const rowOn = async (name: string, host: Worker) =>
  (await rows(name)).find((x) => x.hostId === host.hostId);

const refsIn = (repo: string, prefix: string) =>
  git(repo, "for-each-ref", "--format=%(refname)", prefix).trim().split("\n").filter(Boolean);

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  a = await w.addWorker("a", ["proj"]);
  b = await w.addWorker("b", ["proj"]);
  // B holds the repo once it has a worktree of it, which a restore needs.
  await w.createWorktree(b, "proj", "seed-b");
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("opening a worktree on a host that has an older copy", () => {
  it("replaces the older superseded copy with the checkpoint and keeps the old state in a backup ref", async () => {
    const onA = await w.createWorktree(a, "proj", "feat-w");
    const aPath = w.worktreePath(a, "proj", "feat-w");
    writeFileSync(join(aPath, "hello.txt"), "edited on A\n");
    await w.m("checkpoints.take", { worktreeId: onA });
    await w.killWorker(a);
    const onB = (
      await w.m<ContinueReply>("follow.continue", { worktreeId: onA, toHostId: b.hostId })
    ).worktreeId;
    a = await w.restartWorker(a);

    // The old copy on A moves on by itself: a commit and an uncommitted file nobody carried over.
    writeFileSync(join(aPath, "a-commit.txt"), "committed on A\n");
    git(aPath, "add", "a-commit.txt");
    git(aPath, "commit", "-q", "-m", "a-commit");
    writeFileSync(join(aPath, "a-only.txt"), "only on A\n");

    // The work goes on at B, then B goes away and the work comes back to A.
    const bPath = w.worktreePath(b, "proj", "feat-w");
    writeFileSync(join(bPath, "hello.txt"), "edited on B\n");
    writeFileSync(join(bPath, "from-b.txt"), "written on B\n");
    await w.m("checkpoints.take", { worktreeId: onB });
    await w.killWorker(b);
    const back = await w.m<ContinueReply>("follow.continue", {
      worktreeId: onB,
      toHostId: a.hostId,
    });
    expect(back.worktreeId).toBe(onA);

    // The checkpoint wins.
    expect(readFileSync(join(aPath, "hello.txt"), "utf8")).toBe("edited on B\n");
    expect(readFileSync(join(aPath, "from-b.txt"), "utf8")).toBe("written on B\n");
    expect(existsSync(join(aPath, "a-only.txt"))).toBe(false);
    expect(existsSync(join(aPath, "a-commit.txt"))).toBe(false);

    // What A held is kept: the folder with its uncommitted file, and the branch with its commit.
    const backups = refsIn(aPath, `refs/band/backup/${onA}`);
    expect(backups.length).toBeGreaterThanOrEqual(2);
    const folder = backups.find((r) => !r.endsWith("-branch"));
    const branch = backups.find((r) => r.endsWith("-branch"));
    expect(git(aPath, "show", `${folder}:a-only.txt`)).toBe("only on A\n");
    expect(git(aPath, "show", `${folder}:a-commit.txt`)).toBe("committed on A\n");
    expect(git(aPath, "log", "--format=%s", branch as string)).toContain("a-commit");

    // Nothing is deleted: the older folder, ignored files included, sits beside the restored one.
    const aside = readdirSync(dirname(aPath)).filter((f) => f.startsWith("feat-w.band-backup-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dirname(aPath), aside[0] as string, "a-only.txt"), "utf8")).toBe(
      "only on A\n",
    );
    expect(git(aPath, "worktree", "list", "--porcelain")).not.toContain("band-backup-");

    // The row on A is a live copy again, and the copy on B is the superseded one.
    const rowA = await rowOn("feat-w", a);
    expect(rowA?.supersededBy).toBeUndefined();
    expect(rowA?.continuedFrom?.fromHostId).toBe(b.hostId);
    expect((await rowOn("feat-w", b))?.supersededBy).toBe(onA);
  }, 180_000);
});

describe("the default branch", () => {
  it("is opened on another host over the target's own checkout, and discarding the old one resets it", async () => {
    // B went away in the test above. Both workers record their clone's checkout of main.
    b = await w.restartWorker(b);
    for (const worker of [a, b]) {
      await w.m("repos.addFromWorker", {
        hostId: worker.hostId,
        path: join(worker.root, "proj"),
      });
    }
    const mainA = `proj-main@${a.hostId}`;
    const aRoot = join(a.root, "proj");
    const bRoot = join(b.root, "proj");

    writeFileSync(join(aRoot, "root-change.txt"), "uncommitted on A's main\n");
    writeFileSync(join(bRoot, "b-root.txt"), "B's own local state\n");
    await w.m("checkpoints.take", { worktreeId: mainA });

    await w.killWorker(a);
    const moved = await w.m<ContinueReply>("follow.continue", {
      worktreeId: mainA,
      toHostId: b.hostId,
    });
    expect(moved.worktreeId).toBe(`proj-main@${b.hostId}`);

    // B's root now holds A's work, and its own state is in a backup ref.
    expect(readFileSync(join(bRoot, "root-change.txt"), "utf8")).toBe("uncommitted on A's main\n");
    expect(existsSync(join(bRoot, "b-root.txt"))).toBe(false);
    expect(git(bRoot, "branch", "--show-current").trim()).toBe("main");
    const backup = refsIn(bRoot, `refs/band/backup/${moved.worktreeId}`)[0];
    expect(git(bRoot, "show", `${backup}:b-root.txt`)).toBe("B's own local state\n");

    // A comes back. Discarding its superseded copy resets main to the latest, and keeps the folder.
    a = await w.restartWorker(a);
    // (`repos.list` hides the default branch of every host but the primary, so ask the offer.)
    const offerFor = () =>
      w.q<{ blocked?: { reason: string } }>("follow.offer", { worktreeId: mainA });
    expect((await offerFor()).blocked?.reason).toBe("already-continued");
    await w.m("follow.discardOld", { worktreeId: mainA, confirm: true, discardChanges: true });
    expect(existsSync(aRoot)).toBe(true);
    expect(existsSync(join(aRoot, "root-change.txt"))).toBe(false);
    expect(git(aRoot, "status", "--porcelain").trim()).toBe("");
    expect((await offerFor()).blocked?.reason).not.toBe("already-continued");
  }, 240_000);

  it("is not opened over a default-branch worktree that has a terminal running", async () => {
    const mainA = `proj-main@${a.hostId}`;
    const mainB = `proj-main@${b.hostId}`;
    writeFileSync(join(a.root, "proj", "late-change.txt"), "changed again on A\n");
    await w.m("checkpoints.take", { worktreeId: mainA });
    await w.m("terminal.create", { worktreeId: mainB, id: randomUUID() });
    await w.killWorker(a);

    const refused = await w.mFail("follow.continue", { worktreeId: mainA, toHostId: b.hostId });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body).toContain("Stop it first");
    expect(existsSync(join(b.root, "proj", "late-change.txt"))).toBe(false);
  }, 240_000);
});
