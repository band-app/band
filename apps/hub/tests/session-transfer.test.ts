// Integration tests for the agent sessions of a worktree that is moved or continued to another
// host: the session files are re-homed to the folder of the new path, and the listed default
// branch follows the live copy. A real hub and two real `band-worker` processes (see
// helpers/checkpoint-world.ts) with separate homes and worktree roots, the coding agent is the
// scripted ACP stub, and everything lives in temp dirs.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { claudeProjectSlug } from "@band-app/shared/claude-session";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";

interface Worktree {
  name: string;
  path: string;
  hostId?: string;
  supersededBy?: string;
}
interface ReposList {
  repos: Array<{ name: string; primaryHostId: string | null; worktrees: Worktree[] }>;
}
interface Moved {
  worktreeId: string;
}

let w: World;
let a: Worker;
let b: Worker;

const listed = async (repo: string) =>
  (await w.q<ReposList>("repos.list")).repos.find((r) => r.name === repo);

const pathOf = async (repo: string, name: string, hostId: string) =>
  (await listed(repo))?.worktrees.find((x) => x.name === name && x.hostId === hostId)?.path ?? "";

const sessionIdOf = async (chatId: string) =>
  (await w.q<{ chat: { activeSessionId?: string } }>("chats.get", { chatId })).chat
    .activeSessionId as string;

/** Claude's session file for `cwd` under a worker's home, with `cwd` recorded in each line. */
function seedClaude(worker: Worker, cwd: string, sessionId: string): void {
  const file = join(
    worker.home,
    ".claude",
    "projects",
    claudeProjectSlug(cwd),
    `${sessionId}.jsonl`,
  );
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    { type: "user", cwd, sessionId, message: { role: "user", content: "remember: banana" } },
    { type: "assistant", cwd, sessionId, message: { role: "assistant", content: "banana" } },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function seedCodex(worker: Worker, cwd: string, sessionId: string): void {
  const file = join(
    worker.home,
    ".codex",
    "sessions",
    "2026",
    "10",
    "15",
    `rollout-2026-10-15T00-00-00-${sessionId}.jsonl`,
  );
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id: sessionId, cwd } },
    { type: "turn_context", payload: { cwd } },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function claudeFilesOf(worker: Worker, sessionId: string): string[] {
  const root = join(worker.home, ".claude", "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((dir) => existsSync(join(root, dir, `${sessionId}.jsonl`)))
    .map((dir) => dir);
}

function codexFile(worker: Worker, sessionId: string): string {
  return join(
    worker.home,
    ".codex",
    "sessions",
    "2026",
    "10",
    "15",
    `rollout-2026-10-15T00-00-00-${sessionId}.jsonl`,
  );
}

const cwdsOf = (file: string): string[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const o = JSON.parse(line) as { cwd?: string; payload?: { cwd?: string } };
      return [o.cwd ?? o.payload?.cwd ?? ""];
    });

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  a = await w.addWorker("a", ["proj"]);
  b = await w.addWorker("b", ["proj"]);
  await w.createWorktree(b, "proj", "seed-b");
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("agent sessions follow a worktree to another host", () => {
  it("re-homes the Claude and Codex session files of a moved worktree (S2, S3)", async () => {
    const id = await w.createWorktree(a, "proj", "feat-mv");
    await w.turn(id, "mv-chat", "remember: banana");
    const sessionId = await sessionIdOf("mv-chat");
    const aPath = await pathOf("proj", "feat-mv", a.hostId);
    seedClaude(a, aPath, sessionId);
    seedCodex(a, aPath, sessionId);

    const result = await w.m<Moved>("checkpoints.move", { worktreeId: id, toHostId: b.hostId });
    const bPath = await pathOf("proj", "feat-mv", b.hostId);
    expect(bPath).not.toBe(aPath);

    expect(claudeFilesOf(b, sessionId)).toEqual([claudeProjectSlug(bPath)]);
    const claude = join(
      b.home,
      ".claude",
      "projects",
      claudeProjectSlug(bPath),
      `${sessionId}.jsonl`,
    );
    expect(cwdsOf(claude)).toEqual([bPath, bPath]);

    expect(cwdsOf(codexFile(b, sessionId))).toEqual([bPath, bPath]);

    // The chat opens on the new worktree and its agent reattaches to the moved session.
    await w.turn(result.worktreeId, "mv-chat", "what was it?");
    expect(
      [...w.stubRequests(b, "session/resume"), ...w.stubRequests(b, "session/load")].length,
    ).toBeGreaterThan(0);
  }, 180_000);

  it("re-homes the session files when the old host is offline (S1)", async () => {
    const id = await w.createWorktree(a, "proj", "feat-off");
    await w.turn(id, "off-chat", "remember: banana");
    const sessionId = await sessionIdOf("off-chat");
    const aPath = await pathOf("proj", "feat-off", a.hostId);
    seedClaude(a, aPath, sessionId);
    await w.m("checkpoints.take", { worktreeId: id });
    await w.killWorker(a);

    const result = await w.m<Moved>("follow.continue", { worktreeId: id, toHostId: b.hostId });
    const bPath = await pathOf("proj", "feat-off", b.hostId);

    // Only the folder of the new path exists on B; none is made for A's path.
    expect(claudeFilesOf(b, sessionId)).toEqual([claudeProjectSlug(bPath)]);
    const claude = join(
      b.home,
      ".claude",
      "projects",
      claudeProjectSlug(bPath),
      `${sessionId}.jsonl`,
    );
    expect(cwdsOf(claude)).toEqual([bPath, bPath]);
    expect(existsSync(join(b.home, ".claude", "projects", claudeProjectSlug(aPath)))).toBe(false);

    await w.turn(result.worktreeId, "off-chat", "carry on");
    expect(
      [...w.stubRequests(b, "session/resume"), ...w.stubRequests(b, "session/load")].length,
    ).toBeGreaterThan(0);
    a = await w.restartWorker(a);
  }, 240_000);
});

describe("the default branch follows the live copy (S7)", () => {
  it("lists the continued copy and makes its host primary, and back again", async () => {
    const aMain = `proj-main@${a.hostId}`;
    const bMain = `proj-main@${b.hostId}`;
    for (const worker of [a, b]) {
      await w.m("repos.addFromWorker", { hostId: worker.hostId, path: join(worker.root, "proj") });
    }
    await w.m("repos.update", { name: "proj", primaryHostId: a.hostId });
    const before = await listed("proj");
    expect(before?.primaryHostId).toBe(a.hostId);
    expect(before?.worktrees.some((x) => x.name === "main" && x.hostId === a.hostId)).toBe(true);

    await w.m("checkpoints.take", { worktreeId: aMain });
    await w.killWorker(a);
    const first = await w.m<Moved>("follow.continue", { worktreeId: aMain, toHostId: b.hostId });
    expect(first.worktreeId).toBe(bMain);

    const after = await listed("proj");
    expect(after?.primaryHostId).toBe(b.hostId);
    const mains = after?.worktrees.filter((x) => x.name === "main") ?? [];
    expect(mains.map((x) => x.hostId)).toEqual([b.hostId]);

    // Back to A once it is online again.
    a = await w.restartWorker(a);
    await w.m("checkpoints.take", { worktreeId: bMain });
    await w.killWorker(b);
    const back = await w.m<Moved>("follow.continue", { worktreeId: bMain, toHostId: a.hostId });
    expect(back.worktreeId).toBe(aMain);
    const final = await listed("proj");
    expect(final?.primaryHostId).toBe(a.hostId);
    expect(final?.worktrees.filter((x) => x.name === "main").map((x) => x.hostId)).toEqual([
      a.hostId,
    ]);
    b = await w.restartWorker(b);
  }, 300_000);
});

describe("the default branch moves while its host is online (S11, S12)", () => {
  it("refuses while the source has a running terminal or agent work, and changes nothing", async () => {
    const mainA = `proj-main@${a.hostId}`;
    for (const worker of [a, b]) {
      await w.m("repos.addFromWorker", { hostId: worker.hostId, path: join(worker.root, "proj") });
    }
    await w.m("repos.update", { name: "proj", primaryHostId: a.hostId });
    const termId = randomUUID();
    const aRoot = join(a.root, "proj");
    writeFileSync(join(aRoot, "busy.txt"), "uncommitted\n");
    await w.m("terminal.create", { worktreeId: mainA, id: termId });
    const refused = await w.mFail("checkpoints.move", { worktreeId: mainA, toHostId: b.hostId });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body).toMatch(/running agent, queued message or terminal/);
    expect(readFileSync(join(aRoot, "busy.txt"), "utf8")).toBe("uncommitted\n");
    expect(existsSync(join(b.root, "proj", "busy.txt"))).toBe(false);
    expect(
      (await listed("proj"))?.worktrees.find((x) => x.name === "main" && x.hostId === a.hostId)
        ?.supersededBy,
    ).toBeUndefined();
    await w.m("terminal.kill", { terminalId: termId }).catch(() => undefined);
  }, 120_000);

  it("moves an idle main: B gets the files and session, A stays as it was, superseded (S11)", async () => {
    const mainA = `proj-main@${a.hostId}`;
    const aRoot = join(a.root, "proj");
    await w.turn(mainA, "main-chat", "remember: banana");
    const sessionId = await sessionIdOf("main-chat");
    seedClaude(a, aRoot, sessionId);

    const result = await w.m<Moved>("checkpoints.move", { worktreeId: mainA, toHostId: b.hostId });
    expect(result.worktreeId).toBe(`proj-main@${b.hostId}`);

    const bRoot = join(b.root, "proj");
    expect(readFileSync(join(bRoot, "busy.txt"), "utf8")).toBe("uncommitted\n");
    expect(claudeFilesOf(b, sessionId)).toEqual([claudeProjectSlug(bRoot)]);
    const chats = await w.q<{ chats: Array<{ id: string }> }>("chats.list", {
      worktreeId: result.worktreeId,
    });
    expect(chats.chats.map((c) => c.id)).toContain("main-chat");

    // The source clone is untouched and superseded, never removed.
    expect(readFileSync(join(aRoot, "busy.txt"), "utf8")).toBe("uncommitted\n");
    const repo = await listed("proj");
    expect(repo?.primaryHostId).toBe(b.hostId);
    expect(repo?.worktrees.filter((x) => x.name === "main").map((x) => x.hostId)).toEqual([
      b.hostId,
    ]);
  }, 180_000);
});
