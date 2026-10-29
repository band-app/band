// Integration tests for checkpoints on the hub: automatic checkpoints of worktrees on static
// workers, the offline view, restore on another host, move and evacuate, and the per-repo
// setting. A real hub and real `band-worker` processes (see helpers/checkpoint-world.ts), the
// coding agent is the scripted ACP stub, and everything lives in temp dirs.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream, turnEnded } from "./helpers/acp-chat";
import { git, startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { waitFor } from "./helpers/wait-for";

interface ChangesReply {
  checkpoint: { id: string };
  files: Array<{ path: string; status: string }>;
}
interface FilesReply {
  paths: string[];
}
interface FileReply {
  content: string;
}
interface Worktree {
  name: string;
  groupId?: string | null;
  title?: string | null;
  path: string;
  hostId?: string;
  supersededBy?: string;
  lastCheckpointAt: number | null;
}
interface ReposList {
  repos: Array<{
    name: string;
    allowedHostIds: string[] | null;
    checkpointsEnabled: boolean;
    checkpointsSetting: boolean | null;
    worktrees: Worktree[];
  }>;
}
interface TakeReply {
  status: "created" | "unchanged" | "skipped";
}
interface MoveReply {
  worktreeId: string;
  hostId: string;
  supersededId?: string;
  sourceRemoved?: boolean;
}

let w: World;
let a: Worker;
let b: Worker;
// The group the S3 restore test makes; the move test reuses it.
let groupId = "";

const findWorktree = async (repo: string, name: string, hostId?: string) =>
  (await w.q<ReposList>("repos.list")).repos
    .find((r) => r.name === repo)
    ?.worktrees.find((x) => x.name === name && (hostId === undefined || x.hostId === hostId));

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }, { name: "locked" }] });
  a = await w.addWorker("a", ["proj", "locked"]);
  b = await w.addWorker("b", ["proj", "locked"]);
  // B knows the repo once it holds a worktree of it, which a restore needs.
  await w.createWorktree(b, "proj", "seed-b");
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("automatic checkpoints (S1)", () => {
  let wt = "";
  let wtPath = "";

  it("takes a checkpoint after a finished turn that holds uncommitted and untracked work", async () => {
    wt = await w.createWorktree(a, "proj", "feat-x");
    wtPath = w.worktreePath(a, "proj", "feat-x");
    appendFileSync(join(wtPath, "hello.txt"), "edited on the worker\n");
    mkdirSync(join(wtPath, "notes"));
    writeFileSync(join(wtPath, "notes", "scratch.txt"), "scratch\n");

    await w.turn(wt, "ckpt-chat", "remember: banana");

    await waitFor(
      async () => ((await w.checkpoints(wt)).checkpoints.length > 0 ? true : undefined),
      {
        label: "a checkpoint after the turn",
        timeoutMs: 30_000,
      },
    );
    const { checkpoints } = await w.checkpoints(wt);
    expect(checkpoints[0]).toMatchObject({ trigger: "turn", dirty: true });
    expect(checkpoints[0]?.sessions).toBeGreaterThan(0);
    expect((await findWorktree("proj", "feat-x"))?.lastCheckpointAt).toBeGreaterThan(0);
  }, 90_000);

  it("keeps checkpoints on the hub only and creates none when nothing changed", async () => {
    // Let any trigger in flight finish, then ask twice.
    await w.m("checkpoints.take", { worktreeId: wt });
    const before = (await w.checkpoints(wt)).checkpoints.length;
    expect(await w.m<TakeReply>("checkpoints.take", { worktreeId: wt })).toMatchObject({
      status: "unchanged",
    });
    expect((await w.checkpoints(wt)).checkpoints).toHaveLength(before);

    // Never pushed: origin has only main, and the files are under the hub's home.
    const origin = w.origins.get("proj")?.origin as string;
    expect(git(origin, "branch", "--format=%(refname:short)").trim()).toBe("main");
    expect(existsSync(join(w.hubHome, ".band", "checkpoints", wt))).toBe(true);
  }, 60_000);

  it("takes another one after the files stay quiet", async () => {
    const before = (await w.checkpoints(wt)).checkpoints.length;
    appendFileSync(join(wtPath, "hello.txt"), "a quiet edit\n");
    await waitFor(
      async () => ((await w.checkpoints(wt)).checkpoints.length > before ? true : undefined),
      { label: "a checkpoint after the quiet window", timeoutMs: 30_000 },
    );
    expect((await w.checkpoints(wt)).checkpoints[0]?.trigger).toBe("quiet");
  }, 60_000);
});

describe("checkpoint access", () => {
  it("refuses checkpoint reads and restores without a token", async () => {
    const q = (proc: string, input: unknown) =>
      fetch(`${w.server.url}/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`);
    expect((await q("checkpoints.list", { worktreeId: "proj-x" })).status).toBe(401);
    expect((await q("checkpoints.file", { worktreeId: "proj-x", path: "a" })).status).toBe(401);
    const res = await fetch(`${w.server.url}/trpc/checkpoints.restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId: "proj-x", toHostId: "h-none" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("offline view, restore and supersede (S2, S3)", () => {
  const wt = () => `proj-feat-x@${a.hostId}`;
  let restored = "";

  it("reads Changes, Files and chat history from the checkpoint when the host is offline (S2)", async () => {
    await w.m("checkpoints.take", { worktreeId: wt() });
    await w.killWorker(a);

    const worktree = await findWorktree("proj", "feat-x", a.hostId);
    expect(worktree?.lastCheckpointAt).toBeGreaterThan(0);

    const changes = await w.q<ChangesReply>("checkpoints.changes", { worktreeId: wt() });
    expect(changes.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
      "A notes/scratch.txt",
      "M hello.txt",
    ]);
    const files = await w.q<FilesReply>("checkpoints.files", { worktreeId: wt() });
    expect(files.paths).toEqual(expect.arrayContaining(["hello.txt", "notes/scratch.txt"]));
    const hello = await w.q<FileReply>("checkpoints.file", { worktreeId: wt(), path: "hello.txt" });
    expect(hello.content).toBe("hello\nedited on the worker\na quiet edit\n");
    const diff = await w.q<{ diff: string }>("checkpoints.diff", {
      worktreeId: wt(),
      path: "notes/scratch.txt",
    });
    expect(diff.diff).toContain("+scratch");

    // The chat log lives on the hub, so the conversation is still there.
    const stream = await openStream(w.server.url, "ckpt-chat", {
      until: turnEnded,
      timeoutMs: 15_000,
    });
    expect((await stream.events).some((e) => e.type === "turn-ended")).toBe(true);
  }, 90_000);

  it("restores on worker B with the work present, the session resumed and the chats moved (S3)", async () => {
    const { group } = await w.m<{ group: { id: string } }>("groups.create", { name: "Restored" });
    groupId = group.id;
    await w.m("worktrees.setGroup", { worktreeId: wt(), groupId });
    await w.m("worktrees.setTitle", { worktreeId: wt(), title: "Restored title" });
    const result = await w.m<MoveReply>("checkpoints.restore", {
      worktreeId: wt(),
      toHostId: b.hostId,
    });
    restored = result.worktreeId;
    expect(restored).toBe(`proj-feat-x@${b.hostId}`);
    expect(result.supersededId).toBe(wt());
    // The restored copy stays in the group of the one it replaces (S5).
    expect((await findWorktree("proj", "feat-x", b.hostId))?.groupId).toBe(groupId);
    expect((await findWorktree("proj", "feat-x", b.hostId))?.title).toBe("Restored title");

    const path = w.worktreePath(b, "proj", "feat-x");
    expect(readFileSync(join(path, "hello.txt"), "utf8")).toBe(
      "hello\nedited on the worker\na quiet edit\n",
    );
    expect(readFileSync(join(path, "notes", "scratch.txt"), "utf8")).toBe("scratch\n");
    expect(git(path, "branch", "--show-current").trim()).toBe("feat-x");
    // Uncommitted again, as it was.
    expect(git(path, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([
      " M hello.txt",
      "?? notes/",
    ]);

    // The chat belongs to the new worktree and its next message resumes the saved session.
    const chats = (id: string) =>
      w.q<{ chats: Array<{ id: string }> }>("chats.list", { worktreeId: id });
    expect((await chats(restored)).chats.map((c) => c.id)).toContain("ckpt-chat");
    expect((await chats(wt())).chats.map((c) => c.id)).not.toContain("ckpt-chat");
    const evs = await w.turn(restored, "ckpt-chat", "what was it?");
    const resumed = [...w.stubRequests(b, "session/resume"), ...w.stubRequests(b, "session/load")];
    expect(resumed.length).toBeGreaterThan(0);
  }, 120_000);

  it("lists the old copy as superseded and leaves its files alone when A comes back (S3)", async () => {
    const aPath = w.worktreePath(a, "proj", "feat-x");
    const before = readFileSync(join(aPath, "hello.txt"), "utf8");
    a = await w.restartWorker(a);

    const old = await findWorktree("proj", "feat-x", a.hostId);
    expect(old?.supersededBy).toBe(restored);
    expect(readFileSync(join(aPath, "hello.txt"), "utf8")).toBe(before);
    expect(existsSync(join(aPath, "notes", "scratch.txt"))).toBe(true);

    // Band does not run both: no checkpoint is taken of the superseded copy.
    appendFileSync(join(aPath, "hello.txt"), "edited after it was superseded\n");
    const count = (await w.checkpoints(wt())).checkpoints.length;
    await new Promise((r) => setTimeout(r, 4000));
    expect((await w.checkpoints(wt())).checkpoints).toHaveLength(count);
    expect((await findWorktree("proj", "feat-x", b.hostId))?.supersededBy).toBeUndefined();
  }, 90_000);

  it("rejects a checkpoint sent for the superseded copy, however it is asked for (#901)", async () => {
    const before = (await w.checkpoints(wt())).checkpoints.length;
    const refused = await w.mFail("checkpoints.take", { worktreeId: wt() });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body).toContain(`continued as ${restored}`);
    expect((await w.checkpoints(wt())).checkpoints).toHaveLength(before);
  }, 30_000);

  it("takes a checkpoint when a worker shuts down cleanly", async () => {
    const wtB = `proj-seed-b@${b.hostId}`;
    appendFileSync(
      join(w.worktreePath(b, "proj", "seed-b"), "hello.txt"),
      "edited just before shutdown\n",
    );
    const before = (await w.checkpoints(wtB)).checkpoints.length;
    b.child.kill("SIGTERM");
    await b.exited;
    await waitFor(
      async () => ((await w.checkpoints(wtB)).checkpoints.length > before ? true : undefined),
      { label: "a shutdown checkpoint", timeoutMs: 20_000 },
    );
    expect((await w.checkpoints(wtB)).checkpoints[0]?.trigger).toBe("shutdown");
    b = await w.restartWorker(b);
  }, 90_000);
});

describe("move to host and evacuate (S4)", () => {
  it("moves a worktree and removes the source only after the target has it", async () => {
    const wt = await w.createWorktree(a, "proj", "feat-m");
    await w.m("worktrees.setGroup", { worktreeId: wt, groupId });
    await w.m("worktrees.setTitle", { worktreeId: wt, title: "Moved title" });
    const src = w.worktreePath(a, "proj", "feat-m");
    appendFileSync(join(src, "hello.txt"), "moving\n");
    writeFileSync(join(src, "new.txt"), "new\n");
    await w.turn(wt, "move-chat", "hello");

    const result = await w.m<MoveReply>("checkpoints.move", { worktreeId: wt, toHostId: b.hostId });
    expect(result).toMatchObject({
      worktreeId: `proj-feat-m@${b.hostId}`,
      hostId: b.hostId,
      sourceRemoved: true,
    });

    expect((await findWorktree("proj", "feat-m", b.hostId))?.groupId).toBe(groupId);
    expect((await findWorktree("proj", "feat-m", b.hostId))?.title).toBe("Moved title");
    const dst = w.worktreePath(b, "proj", "feat-m");
    expect(readFileSync(join(dst, "hello.txt"), "utf8")).toBe("hello\nmoving\n");
    expect(readFileSync(join(dst, "new.txt"), "utf8")).toBe("new\n");
    await waitFor(async () => (existsSync(src) ? undefined : true), {
      label: "the source folder is removed",
      timeoutMs: 20_000,
    });
    expect(await findWorktree("proj", "feat-m", a.hostId)).toBeUndefined();
    const chats = await w.q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: result.worktreeId,
    });
    expect(chats.chats.map((c) => c.id)).toContain("move-chat");
  }, 120_000);

  it("keeps the source when the target cannot take the worktree", async () => {
    const wt = await w.createWorktree(a, "proj", "feat-n");
    const src = w.worktreePath(a, "proj", "feat-n");
    writeFileSync(join(src, "keep.txt"), "mine\n");
    // The target path is taken, so the restore must refuse.
    mkdirSync(w.worktreePath(b, "proj", "feat-n"), { recursive: true });

    const failed = await w.mFail("checkpoints.move", { worktreeId: wt, toHostId: b.hostId });
    expect(failed.status).not.toBe(200);
    expect(readFileSync(join(src, "keep.txt"), "utf8")).toBe("mine\n");
    expect((await findWorktree("proj", "feat-n", a.hostId))?.supersededBy).toBeUndefined();
  }, 90_000);

  it("moves every worktree on a host (Move all)", async () => {
    const ids = [
      await w.createWorktree(a, "proj", "feat-p"),
      await w.createWorktree(a, "proj", "feat-q"),
    ];
    for (const branch of ["feat-p", "feat-q"]) {
      writeFileSync(join(w.worktreePath(a, "proj", branch), `${branch}.txt`), `${branch}\n`);
    }
    const listed = await w.q<{ worktrees: Array<{ worktreeId: string }> }>(
      "checkpoints.evacuable",
      { hostId: a.hostId },
    );
    expect(listed.worktrees.map((x) => x.worktreeId)).toEqual(expect.arrayContaining(ids));

    const summary = await w.m<{
      results: Array<{ worktreeId: string; ok: boolean; error?: string }>;
    }>("checkpoints.evacuate", { fromHostId: a.hostId, toHostId: b.hostId });
    // One worktree that cannot move (feat-n, whose target path is taken) does not stop the rest.
    expect(summary.results.find((r) => r.worktreeId === `proj-feat-n@${a.hostId}`)?.ok).toBe(false);
    expect(summary.results.filter((r) => ids.includes(r.worktreeId)).every((r) => r.ok)).toBe(true);
    for (const branch of ["feat-p", "feat-q"]) {
      expect(readFileSync(join(w.worktreePath(b, "proj", branch), `${branch}.txt`), "utf8")).toBe(
        `${branch}\n`,
      );
      await waitFor(
        async () => (existsSync(w.worktreePath(a, "proj", branch)) ? undefined : true),
        {
          label: `${branch} is removed from A`,
          timeoutMs: 20_000,
        },
      );
    }
  }, 180_000);
});

describe("repos limited to chosen hosts (S5, S6)", () => {
  it("keeps no checkpoints by default, and keeps them once the setting is on (S5)", async () => {
    await w.m("repos.update", { name: "locked", allowedHostIds: [a.hostId] });
    const repo = (await w.q<ReposList>("repos.list")).repos.find((r) => r.name === "locked");
    expect(repo).toMatchObject({ checkpointsEnabled: false, checkpointsSetting: null });

    const wt = await w.createWorktree(a, "locked", "feat-l");
    writeFileSync(join(w.worktreePath(a, "locked", "feat-l"), "secret.txt"), "secret\n");
    await w.turn(wt, "locked-chat", "hello");
    await new Promise((r) => setTimeout(r, 4000));
    expect((await w.checkpoints(wt)).checkpoints).toHaveLength(0);
    expect(existsSync(join(w.hubHome, ".band", "checkpoints", wt))).toBe(false);
    expect((await w.mFail("checkpoints.take", { worktreeId: wt })).status).toBe(412);

    await w.m("repos.update", { name: "locked", checkpointsEnabled: true });
    await w.turn(wt, "locked-chat", "again");
    await waitFor(
      async () => ((await w.checkpoints(wt)).checkpoints.length > 0 ? true : undefined),
      {
        label: "a checkpoint once the setting is on",
        timeoutMs: 30_000,
      },
    );
    expect(
      (await w.q<ReposList>("repos.list")).repos.find((r) => r.name === "locked"),
    ).toMatchObject({ checkpointsEnabled: true, checkpointsSetting: true });
  }, 120_000);

  it("refuses a restore on a host the repo is not allowed on unless the host is added (S6)", async () => {
    const wt = `locked-feat-l@${a.hostId}`;
    await w.m("checkpoints.take", { worktreeId: wt });

    const refused = await w.mFail("checkpoints.restore", { worktreeId: wt, toHostId: b.hostId });
    expect(refused.status).toBe(412);
    expect(refused.body).toContain("only available on");
    expect(
      (await w.q<ReposList>("repos.list")).repos.find((r) => r.name === "locked")?.allowedHostIds,
    ).toEqual([a.hostId]);
    expect(existsSync(w.worktreePath(b, "locked", "feat-l"))).toBe(false);

    // The repo has no remote URL, so the restore is told where B keeps its clone.
    const ok = await w.m<MoveReply>("checkpoints.restore", {
      worktreeId: wt,
      toHostId: b.hostId,
      addHost: true,
      hostRepoPath: join(b.root, "locked"),
    });
    expect(ok.hostId).toBe(b.hostId);
    expect(
      (await w.q<ReposList>("repos.list")).repos.find((r) => r.name === "locked")?.allowedHostIds,
    ).toEqual(expect.arrayContaining([a.hostId, b.hostId]));
    expect(readFileSync(join(w.worktreePath(b, "locked", "feat-l"), "secret.txt"), "utf8")).toBe(
      "secret\n",
    );
  }, 120_000);
});

describe("one restore at a time", () => {
  it("refuses a second restore of a worktree while the first one runs", async () => {
    const wt = await w.createWorktree(a, "proj", "feat-twice");
    writeFileSync(join(w.worktreePath(a, "proj", "feat-twice"), "twice.txt"), "twice\n");
    await w.m("checkpoints.take", { worktreeId: wt });

    const results = await Promise.all([
      w.mFail("checkpoints.restore", { worktreeId: wt, toHostId: b.hostId }),
      w.mFail("checkpoints.restore", { worktreeId: wt, toHostId: b.hostId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toContain("is being restored or moved");
    expect(readFileSync(join(w.worktreePath(b, "proj", "feat-twice"), "twice.txt"), "utf8")).toBe(
      "twice\n",
    );
  }, 120_000);
});
