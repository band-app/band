// Integration tests for taking over a chat whose owning worker is gone: a real hub, a worker A
// started with `--own-chats` that dials the hub through a proxy the test can cut, and a worker B
// that also owns chats. The lease is short, so A fences soon after the cut. The coding agent is
// the scripted ACP stub on both workers.
//
//   S1  before the lease runs out the offer says lease-active; after it, Continue on B restores
//       the worktree, the chat's history is there and a new message runs on B.
//   S2  a message sent while A was down runs on B after the continuation, exactly once.
//   S3  what A logged after the cut shows only as held events (count and time); View reads them,
//       Discard deletes them; the live chat is unchanged.
//   S4  A does not start an agent for the chat when it reconnects.
//   S5  with auto-continue on, a message after the lease continues the work without a click.
//   S6  an agent through the relay cannot reach the held-events procedures (remote-relay.test.ts).

import type { DirectAccess } from "@band-app/shared/direct-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentText, openStream, TEST_TOKEN } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { type CuttableProxy, startCuttableProxy } from "./helpers/cuttable-proxy";
import { waitFor } from "./helpers/wait-for";

const LEASE_MS = 6000;

interface Offer {
  blocked?: { reason: string };
  targets: Array<{ hostId: string; recommended: boolean }>;
}
interface Held {
  hostId: string;
  count: number;
  firstAt: number;
  fromHostName: string;
  continuedOnHostName: string;
}

let w: World;
let a: Worker;
let b: Worker;
let proxy: CuttableProxy;

const hostStatus = async (id: string) =>
  (await w.q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
    (h) => h.id === id,
  )?.status;

const promptsOn = (worker: Worker): string[] =>
  w
    .stubRequests(worker, "session/prompt")
    .map((r) => JSON.stringify((r.params as { prompt?: unknown }).prompt ?? ""));

async function sendToHub(chatId: string, worktreeId: string, text: string) {
  const res = await fetch(`${w.server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const offer = (worktreeId: string, chatId: string) =>
  w.q<Offer>("follow.offer", { worktreeId, chatId });
const held = (chatId: string) => w.q<Held | null>("follow.heldEvents", { chatId });
const ownerOf = async (chatId: string) =>
  (await w.q<{ chat: { ownerHostId?: string } | null }>("chats.get", { chatId })).chat?.ownerHostId;

/** Cuts A off the hub and waits until the hub sees it offline. */
async function cutA() {
  await proxy.cut();
  await waitFor(async () => ((await hostStatus(a.hostId)) !== "online" ? true : undefined), {
    label: "A offline",
    timeoutMs: 60_000,
  });
}

async function waitLeaseOver(worktreeId: string, chatId: string) {
  await waitFor(async () => ((await offer(worktreeId, chatId)).blocked ? undefined : true), {
    label: "the lease to run out",
    timeoutMs: 30_000,
  });
}

beforeAll(async () => {
  w = await startWorld({
    repos: [{ name: "proj" }, { name: "auto" }],
    env: { BAND_WORKER_LEASE_MS: String(LEASE_MS), BAND_AUTO_CONTINUE_MAX_AGE_MS: "120000" },
  });
  proxy = await startCuttableProxy(w.server.url);
  a = await w.addWorker("a", ["proj", "auto"], {
    ownChats: true,
    hubUrl: proxy.url,
  });
  b = await w.addWorker("b", ["proj", "auto"], { ownChats: true });
  await w.createWorktree(b, "proj", "seed-b");
  await w.createWorktree(b, "auto", "seed-b");
}, 180_000);

afterAll(async () => {
  await proxy?.close();
  await w?.close();
});

describe("taking over an owned chat once its worker's lease is over (S1 to S4)", () => {
  const chatId = "takeover-chat";
  let wt = "";
  let wtB = "";
  let direct: { url: string; token: string };

  it("waits for the lease, then continues on B with the chat's history (S1)", async () => {
    wt = await w.createWorktree(a, "proj", "feat-takeover");
    await w.m("chats.create", { worktreeId: wt, id: chatId, name: "Chat" });
    expect(await ownerOf(chatId)).toBe(a.hostId);
    const history = await w.turn(wt, chatId, "remember the history");
    expect(agentText(history)).toContain("remember the history");
    await w.m("checkpoints.take", { worktreeId: wt });
    await waitFor(
      async () => ((await w.checkpoints(wt)).checkpoints.length > 0 ? true : undefined),
      {
        label: "a checkpoint",
        timeoutMs: 30_000,
      },
    );
    const access = await w.m<DirectAccess | null>("worktree.directAccess", {
      worktreeId: wt,
      hostId: a.hostId,
    });
    if (!access) throw new Error("no direct path");
    direct = { url: `http://127.0.0.1:${access.port}`, token: access.token };

    await cutA();
    // Within the lease, A may still be running the chat: no continuation yet.
    expect((await offer(wt, chatId)).blocked?.reason).toBe("lease-active");
    await expect(w.m("follow.continue", { worktreeId: wt, toHostId: b.hostId })).rejects.toThrow();

    // S2: a message sent while A is down waits in the outbox, then runs on B once.
    const sent = await sendToHub(chatId, wt, "sent while A was down");
    expect(sent.status).toBe(200);

    // What A logs on its own after the cut (S3). A fences when its lease runs out.
    await fetch(`${direct.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${direct.token}` },
      body: JSON.stringify({ worktreeId: wt, text: "logged by A after the cut" }),
    });
    await new Promise((r) => setTimeout(r, 1500));

    await waitLeaseOver(wt, chatId);
    const result = await w.m<{ worktreeId: string }>("follow.continue", {
      worktreeId: wt,
      toHostId: b.hostId,
    });
    wtB = result.worktreeId;
    expect(wtB).toBe(`proj-feat-takeover@${b.hostId}`);
    expect(await ownerOf(chatId)).toBe(b.hostId);

    // The message that waited for A runs first, then a new one.
    await waitFor(
      () => (promptsOn(b).some((p) => p.includes("sent while A was down")) ? true : undefined),
      { label: "the waiting message on B", timeoutMs: 30_000 },
    );
    const sentOnB = await sendToHub(chatId, wtB, "carry on on B");
    expect(sentOnB.status).toBe(200);
    await waitFor(
      () => (promptsOn(b).some((p) => p.includes("carry on on B")) ? true : undefined),
      {
        label: "the new message on B",
        timeoutMs: 30_000,
      },
    );
    // The history came with the chat.
    const replay = await openStream(w.server.url, chatId, {
      until: (e) => e.type === "history-meta",
      timeoutMs: 10_000,
    });
    const prompts = (await replay.events).flatMap((e) => (e.type === "prompt" ? [e.text] : []));
    expect(prompts).toContain("remember the history");
    expect(prompts).toContain("carry on on B");
  }, 240_000);

  it("runs the message sent while A was down on B, exactly once (S2)", async () => {
    await waitFor(
      () => (promptsOn(b).some((p) => p.includes("sent while A was down")) ? true : undefined),
      {
        label: "the waiting message on B",
        timeoutMs: 30_000,
      },
    );
    expect(promptsOn(b).filter((p) => p.includes("sent while A was down"))).toHaveLength(1);
    expect(promptsOn(a).filter((p) => p.includes("sent while A was down"))).toHaveLength(0);
  }, 60_000);

  it("shows what A logged after the cut only as held events, and discards them (S3, S4)", async () => {
    const promptsBefore = promptsOn(a).length;
    await proxy.restore();
    await waitFor(async () => ((await hostStatus(a.hostId)) === "online" ? true : undefined), {
      label: "A back online",
      timeoutMs: 60_000,
    });
    // A either replicated rows for the chat it no longer owns, or logged none when it fenced.
    const summary = await waitFor(async () => (await held(chatId)) ?? undefined, {
      label: "held events",
      timeoutMs: 30_000,
    });
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.hostId).toBe(a.hostId);
    expect(summary.firstAt).toBeGreaterThan(0);

    const transcript = await w.q<unknown[]>("follow.heldTranscript", { chatId });
    expect(transcript.length).toBeGreaterThan(0);

    // The live chat did not take them in.
    const replay = await openStream(w.server.url, chatId, {
      until: (e) => e.type === "history-meta",
      timeoutMs: 10_000,
    });
    const hubPrompts = (await replay.events).flatMap((e) => (e.type === "prompt" ? [e.text] : []));
    expect(hubPrompts).not.toContain("logged by A after the cut");
    expect(await ownerOf(chatId)).toBe(b.hostId);

    // S4: A started no agent for the chat.
    expect(promptsOn(a).length).toBe(promptsBefore);

    await w.m("follow.discardHeld", { chatId });
    expect(await held(chatId)).toBeNull();
    expect(await ownerOf(chatId)).toBe(b.hostId);
  }, 120_000);
});

describe("auto-continue after the lease (S5)", () => {
  it("continues on B without a click once the lease is over", async () => {
    const wt = await w.createWorktree(a, "auto", "feat-auto");
    const chatId = "auto-chat";
    await w.m("chats.create", { worktreeId: wt, id: chatId, name: "Chat" });
    await w.turn(wt, chatId, "before the cut");
    await w.m("repos.update", { name: "auto", autoContinue: true });
    await w.m("checkpoints.take", { worktreeId: wt });
    await waitFor(
      async () => ((await w.checkpoints(wt)).checkpoints.length > 0 ? true : undefined),
      {
        label: "a checkpoint",
        timeoutMs: 30_000,
      },
    );
    await cutA();
    await waitLeaseOver(wt, chatId);
    const sent = await sendToHub(chatId, wt, "after the lease");
    expect(sent.status).toBe(200);
    await waitFor(
      () => (promptsOn(b).some((p) => p.includes("after the lease")) ? true : undefined),
      {
        label: "the message on B",
        timeoutMs: 60_000,
      },
    );
    expect(await ownerOf(chatId)).toBe(b.hostId);
  }, 240_000);
});
