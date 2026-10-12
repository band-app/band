// Integration tests for follow the work: when the host of a worktree is offline and someone needs
// a live host, the hub offers to continue on another allowed host from the latest checkpoint (or
// does it by itself when the repo opts in), and it settles the old copy when its host returns.
// A real hub and real `band-worker` processes (see helpers/checkpoint-world.ts), the coding agent
// is the scripted ACP stub, and everything lives in temp dirs.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostOfflineAnswer } from "@band-app/shared/continuation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { waitFor } from "./helpers/wait-for";

const MAX_AGE_MS = 12_000;

interface Worktree {
  name: string;
  path: string;
  hostId?: string;
  supersededBy?: string;
  continuedFrom?: {
    fromHostId: string;
    fromWorktreeId: string;
    toHostId: string;
    checkpointId: string;
    reason: "manual" | "auto";
  };
  divergence?: { state: "clean" | "diverged" | "resolved" };
}
interface ReposList {
  repos: Array<{ name: string; autoContinue: boolean; worktrees: Worktree[] }>;
}
interface ContinueResult {
  worktreeId: string;
  hostId: string;
  continuedFrom: { reason: string; checkpointId: string; fromHostId: string };
}
interface Divergence {
  state: string;
  hostOnline: boolean;
  files: Array<{ path: string; status: string }>;
}
interface BringOver {
  applied: boolean;
  files: number;
  conflicts: Array<{ path: string }>;
}

let w: World;
let a: Worker;
let b: Worker;
let c: Worker;

const worktreeOf = async (repo: string, name: string, hostId: string) =>
  (await w.q<ReposList>("repos.list")).repos
    .find((r) => r.name === repo)
    ?.worktrees.find((x) => x.name === name && x.hostId === hostId);

/** What a send does: the status and body of POST /api/chats/:id/messages. */
async function send(chatId: string, worktreeId: string, text: string, extra: object = {}) {
  const res = await fetch(`${w.server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const offlineAnswer = (body: Record<string, unknown>) => body as unknown as HostOfflineAnswer;

/** The texts the stub agent on `worker` received as prompts. */
function promptsOn(worker: Worker): string[] {
  return w
    .stubRequests(worker, "session/prompt")
    .map((r) => JSON.stringify((r.params as { prompt?: unknown }).prompt ?? ""));
}

/** A worktree on worker A with one finished turn and a checkpoint of it. */
async function worktreeWithCheckpoint(
  worker: Worker,
  repo: string,
  branch: string,
  chatId?: string,
): Promise<string> {
  const id = await w.createWorktree(worker, repo, branch);
  if (chatId) await w.turn(id, chatId, `remember: ${branch}`);
  await w.m("checkpoints.take", { worktreeId: id });
  await waitFor(async () => ((await w.checkpoints(id)).checkpoints.length > 0 ? true : undefined), {
    label: `a checkpoint of ${id}`,
    timeoutMs: 30_000,
  });
  return id;
}

beforeAll(async () => {
  w = await startWorld({
    repos: [{ name: "proj" }, { name: "locked" }, { name: "nockpt" }, { name: "agentrepo" }],
    env: { BAND_AUTO_CONTINUE_MAX_AGE_MS: String(MAX_AGE_MS) },
    settings: {
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code" },
        {
          id: "opencode-a",
          type: "opencode",
          label: "OpenCode",
          command: "/nonexistent/band-test/opencode",
        },
      ],
    },
  });
  a = await w.addWorker("a", ["proj", "locked", "nockpt", "agentrepo"]);
  b = await w.addWorker("b", ["proj"]);
  c = await w.addWorker("c", ["agentrepo"], { noStubAgent: true });
  // B knows the repo once it holds a worktree of it, which a restore needs.
  await w.createWorktree(b, "proj", "seed-b");
}, 180_000);

afterAll(async () => {
  await w?.close();
});

describe("follow access", () => {
  it("refuses continue, bring over and discard without a token", async () => {
    for (const proc of ["follow.continue", "follow.bringOver", "follow.discardOld"]) {
      const res = await fetch(`${w.server.url}/trpc/${proc}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreeId: "proj-x", confirm: true }),
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("the prompt, accepting, and the divergence of the old copy (S1, S4)", () => {
  let s1 = "";
  let s4 = "";
  let s1New = "";
  let s4New = "";

  it("offers worker B for a chat message and reading never triggers it (S1)", async () => {
    s1 = await worktreeWithCheckpoint(a, "proj", "feat-s1", "s1-chat");
    s4 = await worktreeWithCheckpoint(a, "proj", "feat-s4");
    appendFileSync(join(w.worktreePath(a, "proj", "feat-s1"), "hello.txt"), "checkpointed\n");
    await w.m("checkpoints.take", { worktreeId: s1 });
    writeFileSync(
      join(w.worktreePath(a, "proj", "feat-s4"), "hello.txt"),
      "hello from the checkpoint\n",
    );
    await w.m("checkpoints.take", { worktreeId: s4 });
    await w.killWorker(a);

    // Reading: the checkpoint serves it, the worktree stays on A.
    const changes = await w.q<{ files: unknown[] }>("checkpoints.changes", { worktreeId: s1 });
    expect(changes.files.length).toBeGreaterThan(0);
    expect(await worktreeOf("proj", "feat-s1", a.hostId)).toBeDefined();
    expect(await worktreeOf("proj", "feat-s1", b.hostId)).toBeUndefined();

    // Acting: the message is refused with the offer, and nothing is sent to an agent.
    const sent = await send("s1-chat", s1, "carry on");
    expect(sent.status).toBe(409);
    const answer = offlineAnswer(sent.body);
    expect(answer.code).toBe("HOST_OFFLINE");
    expect(answer.error).toMatch(/is offline\. Continue on .+ from the checkpoint taken .+ ago\?/);
    expect(answer.offer.targets.map((t) => t.hostId)).toContain(b.hostId);
    expect(answer.offer.targets.find((t) => t.recommended)?.hostId).toBe(b.hostId);
    expect(answer.offer.limits.join(" ")).toMatch(/Ignored files/);
    expect(answer.offer.limits.join(" ")).toMatch(/Running processes/);
    expect(answer.offer.willRun.join(" ")).toMatch(/[Ss]etup/);
    expect(promptsOn(b)).toHaveLength(0);
  }, 180_000);

  it("continues on B, resumes the agent session and delivers the message there (S1)", async () => {
    const result = await w.m<ContinueResult>("follow.continue", {
      worktreeId: s1,
      toHostId: b.hostId,
    });
    s1New = result.worktreeId;
    expect(s1New).toBe(`proj-feat-s1@${b.hostId}`);
    expect(result.continuedFrom).toMatchObject({ reason: "manual", fromHostId: a.hostId });

    const events = await w.turn(s1New, "s1-chat", "carry on");
    expect(events.some((e) => e.type === "turn-ended")).toBe(true);
    const resumed = [...w.stubRequests(b, "session/resume"), ...w.stubRequests(b, "session/load")];
    expect(resumed.length).toBeGreaterThan(0);
    expect(promptsOn(b).some((p) => p.includes("carry on"))).toBe(true);
    expect(readFileSync(join(w.worktreePath(b, "proj", "feat-s1"), "hello.txt"), "utf8")).toContain(
      "checkpointed",
    );

    // The move is recorded on the new copy, and the old one is superseded, not deleted.
    const next = await worktreeOf("proj", "feat-s1", b.hostId);
    expect(next?.continuedFrom).toMatchObject({
      fromHostId: a.hostId,
      toHostId: b.hostId,
      reason: "manual",
    });
    expect(next?.continuedFrom?.checkpointId).toBeTruthy();
    expect((await worktreeOf("proj", "feat-s1", a.hostId))?.supersededBy).toBe(s1New);
    expect(existsSync(join(w.worktreePath(a, "proj", "feat-s1"), "hello.txt"))).toBe(true);

    // The second worktree continues too, for the divergence cases below.
    s4New = (await w.m<ContinueResult>("follow.continue", { worktreeId: s4 })).worktreeId;
    expect(s4New).toBe(`proj-feat-s4@${b.hostId}`);
  }, 180_000);

  it("flags the old copy diverged when A returns with newer changes, and shows the diff (S4)", async () => {
    // A was off: its copies get changes the checkpoint does not have.
    const oldS1 = w.worktreePath(a, "proj", "feat-s1");
    const oldS4 = w.worktreePath(a, "proj", "feat-s4");
    writeFileSync(join(oldS1, "from-a.txt"), "written on A while it was away\n");
    writeFileSync(join(oldS4, "hello.txt"), "hello from A\n");
    // B's copy of s4 moved on too, so bringing A's change over conflicts.
    writeFileSync(join(w.worktreePath(b, "proj", "feat-s4"), "hello.txt"), "hello from B\n");

    a = await w.restartWorker(a);
    await waitFor(
      async () =>
        (await worktreeOf("proj", "feat-s1", a.hostId))?.divergence?.state === "diverged"
          ? true
          : undefined,
      { label: "the old copy is flagged diverged", timeoutMs: 30_000 },
    );
    const report = await w.q<Divergence>("follow.divergence", { worktreeId: s1 });
    expect(report.state).toBe("diverged");
    expect(report.hostOnline).toBe(true);
    expect(report.files.map((f) => `${f.status} ${f.path}`)).toEqual(["A from-a.txt"]);
    const diff = await w.q<{ diff: string }>("follow.divergenceDiff", {
      worktreeId: s1,
      path: "from-a.txt",
    });
    expect(diff.diff).toContain("+written on A while it was away");
  }, 120_000);

  it("brings the changes over to B's copy, and shows conflicts without changing anything (S4)", async () => {
    const applied = await w.m<BringOver>("follow.bringOver", { worktreeId: s1 });
    expect(applied).toMatchObject({ applied: true, conflicts: [] });
    expect(readFileSync(join(w.worktreePath(b, "proj", "feat-s1"), "from-a.txt"), "utf8")).toBe(
      "written on A while it was away\n",
    );
    expect((await worktreeOf("proj", "feat-s1", a.hostId))?.divergence?.state).toBe("resolved");

    const conflict = await w.m<BringOver>("follow.bringOver", { worktreeId: s4 });
    expect(conflict.applied).toBe(false);
    expect(conflict.conflicts.map((x) => x.path)).toContain("hello.txt");
    expect(readFileSync(join(w.worktreePath(b, "proj", "feat-s4"), "hello.txt"), "utf8")).toBe(
      "hello from B\n",
    );
  }, 120_000);

  it("removes nothing on the old host without a confirmation (S4)", async () => {
    const refused = await w.mFail("follow.discardOld", { worktreeId: s4, confirm: false });
    expect(refused.status).not.toBe(200);
    expect(existsSync(join(w.worktreePath(a, "proj", "feat-s4"), "hello.txt"))).toBe(true);
    expect(await worktreeOf("proj", "feat-s4", a.hostId)).toBeDefined();

    await w.m("follow.discardOld", { worktreeId: s4, confirm: true });
    expect(await worktreeOf("proj", "feat-s4", a.hostId)).toBeUndefined();
    expect(existsSync(w.worktreePath(a, "proj", "feat-s4"))).toBe(false);
    // The other old copy is untouched.
    expect(existsSync(join(w.worktreePath(a, "proj", "feat-s1"), "from-a.txt"))).toBe(true);
  }, 120_000);
});

describe("auto-continue (S2)", () => {
  it("continues without a prompt when the checkpoint is fresh, and asks when it is older", async () => {
    await w.m("repos.update", { name: "proj", autoContinue: true });
    expect(
      (await w.q<ReposList>("repos.list")).repos.find((r) => r.name === "proj")?.autoContinue,
    ).toBe(true);

    // Fresh: the same action goes through, on B, with the move recorded as automatic.
    const fresh = await worktreeWithCheckpoint(a, "proj", "feat-s2-fresh", "s2-fresh-chat");
    await w.killWorker(a);
    const sent = await send("s2-fresh-chat", fresh, "go on without asking");
    expect(sent.status).toBe(200);
    const continued = sent.body.continued as { reason: string; toHostId: string };
    expect(continued).toMatchObject({ reason: "auto", toHostId: b.hostId });
    expect(sent.body.worktreeId).toBe(`proj-feat-s2-fresh@${b.hostId}`);
    await waitFor(
      async () => (promptsOn(b).some((p) => p.includes("go on without asking")) ? true : undefined),
      { label: "the message reached B's agent", timeoutMs: 60_000 },
    );
    expect((await worktreeOf("proj", "feat-s2-fresh", b.hostId))?.continuedFrom?.reason).toBe(
      "auto",
    );

    // Older than the threshold: it asks.
    a = await w.restartWorker(a);
    const stale = await worktreeWithCheckpoint(a, "proj", "feat-s2-stale", "s2-stale-chat");
    await w.killWorker(a);
    await new Promise((r) => setTimeout(r, MAX_AGE_MS + 1_500));
    const asked = await send("s2-stale-chat", stale, "this one asks");
    expect(asked.status).toBe(409);
    expect(offlineAnswer(asked.body).code).toBe("HOST_OFFLINE");
    expect(offlineAnswer(asked.body).offer.fresh).toBe(false);
    expect(await worktreeOf("proj", "feat-s2-stale", b.hostId)).toBeUndefined();

    await w.m("repos.update", { name: "proj", autoContinue: false });
  }, 240_000);
});

describe("when it is not possible (S3)", () => {
  it("says a repo restricted to the offline host cannot continue", async () => {
    a = await w.restartWorker(a);
    const id = await worktreeWithCheckpoint(a, "locked", "feat-locked", "locked-chat");
    await w.m("repos.update", { name: "locked", allowedHostIds: [a.hostId] });
    await w.killWorker(a);
    const sent = await send("locked-chat", id, "anyone there?");
    expect(sent.status).toBe(409);
    const answer = offlineAnswer(sent.body);
    expect(answer.code).toBe("CONTINUE_NOT_POSSIBLE");
    expect(answer.offer.blocked?.reason).toBe("restricted-to-offline-host");
    expect(answer.error).toMatch(/only available on/);
    const forced = await w.mFail("follow.continue", { worktreeId: id, toHostId: b.hostId });
    expect(forced.status).not.toBe(200);
  }, 180_000);

  it("says a repo with checkpoints off cannot continue", async () => {
    a = await w.restartWorker(a);
    await w.m("repos.update", { name: "nockpt", checkpointsEnabled: false });
    const id = await w.createWorktree(a, "nockpt", "feat-nockpt");
    await w.turn(id, "nockpt-chat", "no checkpoint will be kept");
    await w.killWorker(a);
    const sent = await send("nockpt-chat", id, "still there?");
    expect(sent.status).toBe(409);
    const answer = offlineAnswer(sent.body);
    expect(answer.code).toBe("CONTINUE_NOT_POSSIBLE");
    expect(answer.offer.blocked?.reason).toBe("checkpoints-off");
    expect(answer.error).toMatch(/Checkpoints are off/);
  }, 180_000);

  it("says so when the agent exists only on the offline host", async () => {
    a = await w.restartWorker(a);
    // The repo may run on A and on C. C has no agent that can start.
    await w.m("repos.update", { name: "agentrepo", allowedHostIds: [a.hostId, c.hostId] });
    await w.m("repos.update", { name: "agentrepo", checkpointsEnabled: true });
    const id = await w.createWorktree(a, "agentrepo", "feat-agent");
    // The chat uses the agent that only A can start.
    const first = await send("agent-chat", id, "use opencode", { codingAgentId: "opencode-a" });
    expect(first.status).toBe(200);
    await waitFor(
      async () => ((await w.checkpoints(id)).checkpoints.length > 0 ? true : undefined),
      {
        label: "a checkpoint",
        timeoutMs: 30_000,
      },
    );
    await w.m("checkpoints.take", { worktreeId: id });
    await w.killWorker(a);
    const sent = await send("agent-chat", id, "continue elsewhere", {
      codingAgentId: "opencode-a",
    });
    expect(sent.status).toBe(409);
    const answer = offlineAnswer(sent.body);
    expect(answer.code).toBe("CONTINUE_NOT_POSSIBLE");
    expect(answer.offer.blocked?.reason).toBe("agent-unavailable");
    expect(answer.error).toMatch(/agent for this work is not available on any other host/);
  }, 240_000);
});
