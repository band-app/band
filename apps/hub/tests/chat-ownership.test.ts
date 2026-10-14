// Integration tests for chats a worker owns (docs/architecture/chat-ownership.md): a real hub
// and real `band-worker` processes (helpers/checkpoint-world.ts), one started with
// `--own-chats` and one without. The coding agent is the scripted ACP stub on the workers. The
// hub's and the worker's event logs are read from their SQLite files, the rest through the hub's
// HTTP and tRPC API.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatEvent } from "@band-app/shared/chat-events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentText, maxId, openStream, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { waitFor } from "./helpers/wait-for";

interface LogRow {
  id: number;
  session_id: string;
  revision: number;
  kind: string;
  turn_start: number;
  payload: string;
}

function readLog(file: string, chatId: string): LogRow[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, session_id, revision, kind, turn_start, payload FROM chat_events WHERE chat_id = ? ORDER BY id",
      )
      .all(chatId) as unknown as LogRow[];
  } finally {
    db.close();
  }
}

interface Chat {
  id: string;
  ownerHostId?: string;
  activeSessionId?: string;
}

let w: World;
let owner: Worker;
let plain: Worker;

const hubLog = (chatId: string) => readLog(join(w.hubHome, ".band", "band.db"), chatId);
const workerLog = (worker: Worker, chatId: string) =>
  readLog(join(worker.state, "chats.db"), chatId);
const getChat = async (chatId: string) =>
  (await w.q<{ chat: Chat | null }>("chats.get", { chatId })).chat ?? undefined;

/** What the scripted agent on the owning worker does: asks for a permission, reports usage, else echoes. */
const SCENARIO = {
  turns: [
    {
      match: "^ask",
      steps: [
        {
          permission: {
            toolCall: { toolCallId: "run-1", title: "Run tests", kind: "execute" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          after: { allow: [{ say: "Allowed and ran." }] },
        },
      ],
    },
    {
      match: "^usage",
      steps: [
        { say: "Counted." },
        { usage: { used: 1200, size: 200000, cost: { amount: 0.42, currency: "USD" } } },
      ],
    },
  ],
};

/** The prompt texts the owning worker's agent received, in order. */
function workerPrompts(worker: Worker): string[] {
  return w
    .stubRequests(worker, "session/prompt")
    .map(
      (r) =>
        ((r.params as { prompt?: Array<{ type: string; text?: string }> }).prompt ?? []).find(
          (b) => b.type === "text",
        )?.text ?? "",
    );
}

async function worktreeStatus(worktreeId: string): Promise<string | undefined> {
  const data = await w.q<{ agent?: { status: string } } | null>("statuses.get", { worktreeId });
  return data?.agent?.status;
}

async function sendViaHub(worktreeId: string, chatId: string, text: string) {
  const res = await fetch(`${w.server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { ok: boolean; queued: boolean };
}

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  const scenario = join(w.tmp("band-own-scenario-"), "scenario.json");
  writeFileSync(scenario, JSON.stringify(SCENARIO));
  owner = await w.addWorker("owner", ["proj"], {
    ownChats: true,
    env: { BAND_TEST_ACP_SCENARIO: scenario },
  });
  plain = await w.addWorker("plain", ["proj"]);
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("a chat on a worker that owns its chats (S2)", () => {
  let wt = "";
  const chatId = "owned-chat";

  it("runs the turn on the worker, and the hub shows it", async () => {
    wt = await w.createWorktree(owner, "proj", "feat-owned");
    const events = await w.turn(wt, chatId, "hello from the hub");
    expect(agentText(events)).toContain("hello from the hub");
    const chat = await getChat(chatId);
    expect(chat?.ownerHostId).toBe(owner.hostId);
    expect(chat?.activeSessionId).toBeTruthy();
    // The worker started the agent itself: its own log has the turn.
    expect(workerLog(owner, chatId).some((r) => r.kind === "turn-ended")).toBe(true);
  }, 90_000);

  it("leaves the hub's log equal to the worker's, same ids and order", async () => {
    await waitFor(
      () => {
        const hub = hubLog(chatId);
        const worker = workerLog(owner, chatId);
        return hub.length > 0 && JSON.stringify(hub) === JSON.stringify(worker) ? true : undefined;
      },
      { label: "the hub's log to catch up", timeoutMs: 10_000 },
    );
    const rows = hubLog(chatId);
    expect(rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["session-attached", "prompt", "turn-started", "turn-ended"]),
    );
  }, 30_000);

  it("shows the same chat to a second client on the hub", async () => {
    const stream = await openStream(w.server.url, chatId, {
      until: (e: ChatEvent) => e.type === "history-meta",
      timeoutMs: 10_000,
    });
    const events = await stream.events;
    const replayed = events.filter((e) => e.eventId > 0).map((e) => e.eventId);
    const logged = workerLog(owner, chatId).map((r) => r.id);
    // Text chunks merge into one event carrying the last chunk's id, so each replayed id is a logged one.
    for (const id of replayed) expect(logged).toContain(id);
    expect(events.some((e) => e.type === "prompt")).toBe(true);
    expect(events.some(turnEnded)).toBe(true);
  }, 30_000);

  it("keeps a second turn in the same session", async () => {
    const before = await getChat(chatId);
    await w.turn(wt, chatId, "second message");
    const after = await getChat(chatId);
    expect(after?.activeSessionId).toBe(before?.activeSessionId);
    const prompts = hubLog(chatId).filter((r) => r.kind === "prompt");
    expect(prompts.map((r) => (JSON.parse(r.payload) as { text: string }).text)).toEqual([
      "hello from the hub",
      "second message",
    ]);
  }, 90_000);
});

describe("a worker that does not own chats (S9)", () => {
  it("leaves the chat on the hub", async () => {
    const wt = await w.createWorktree(plain, "proj", "feat-plain");
    const events = await w.turn(wt, "plain-chat", "hello hub-run");
    expect(agentText(events)).toContain("hello hub-run");
    expect((await getChat("plain-chat"))?.ownerHostId).toBeUndefined();
    expect(existsSync(join(plain.state, "chats.db"))).toBe(false);
    expect(hubLog("plain-chat").some((r) => r.kind === "turn-ended")).toBe(true);
  }, 90_000);
});

describe("requests from the hub side (S4)", () => {
  let wt = "";
  const chatId = "forwarded-chat";

  beforeAll(async () => {
    wt = await w.createWorktree(owner, "proj", "feat-forward");
    await w.turn(wt, chatId, "first");
  }, 90_000);

  it("runs a message pushed to the queue on the worker", async () => {
    await w.m("queue.push", { worktreeId: wt, chatId, text: "queued through trpc" });
    await waitFor(() => (workerPrompts(owner).includes("queued through trpc") ? true : undefined), {
      label: "the queued message on the worker",
      timeoutMs: 30_000,
    });
  }, 60_000);

  it("runs a cron job's prompt on the worker", async () => {
    const created = await w.m<{ job: { id: string } }>("cronjobs.create", {
      key: wt,
      name: "Owned cron",
      prompt: "cron job prompt",
      cronExpression: "0 0 1 1 *",
      scope: "worktree",
      worktreeId: wt,
    });
    const fired = await w.m<{ chatId: string }>("cronjobs.trigger", {
      key: wt,
      id: created.job.id,
    });
    await waitFor(() => (workerPrompts(owner).includes("cron job prompt") ? true : undefined), {
      label: "the cron prompt on the worker",
      timeoutMs: 30_000,
    });
    expect((await getChat(fired.chatId))?.ownerHostId).toBe(owner.hostId);
  }, 60_000);

  it("runs a subscription wake-up on the worker", async () => {
    await w.m("subscriptions.create", {
      source: "timer",
      chatId,
      worktreeId: wt,
      at: Date.now() + 1000,
    });
    await waitFor(
      () =>
        workerPrompts(owner).some((p) => p.includes("Subscription update")) ? true : undefined,
      { label: "the wake-up on the worker", timeoutMs: 30_000 },
    );
  }, 60_000);

  it("delivers a message sent while the worker is offline once, after it reconnects", async () => {
    // Let the wake-up's turn finish first, so the count below is only this message.
    await waitFor(
      async () => {
        const queue = await w.q<{ messages: unknown[] }>("queue.get", { worktreeId: wt, chatId });
        const running = await w.q<{ task: unknown }>("tasks.get", { worktreeId: wt, chatId });
        return queue.messages.length === 0 && !running.task ? true : undefined;
      },
      { label: "the chat to go quiet", timeoutMs: 30_000 },
    );
    await w.killWorker(owner);
    const sent = await sendViaHub(wt, chatId, "sent while offline");
    expect(sent).toMatchObject({ ok: true, queued: true });
    const queued = await w.q<{ messages: Array<{ text: string }> }>("queue.get", {
      worktreeId: wt,
      chatId,
    });
    expect(queued.messages.map((m) => m.text)).toEqual(["sent while offline"]);

    owner = await w.restartWorker(owner);
    await waitFor(() => (workerPrompts(owner).includes("sent while offline") ? true : undefined), {
      label: "the offline message on the worker",
      timeoutMs: 30_000,
    });
    // Give a duplicate time to show up, then count.
    await new Promise((r) => setTimeout(r, 2000));
    expect(workerPrompts(owner).filter((p) => p === "sent while offline")).toHaveLength(1);
    await waitFor(
      () => {
        const prompts = hubLog(chatId)
          .filter((r) => r.kind === "prompt")
          .map((r) => (JSON.parse(r.payload) as { text: string }).text);
        return prompts.includes("sent while offline") ? prompts : undefined;
      },
      { label: "the hub's copy of the offline turn", timeoutMs: 15_000 },
    );
    const prompts = hubLog(chatId)
      .filter((r) => r.kind === "prompt")
      .map((r) => (JSON.parse(r.payload) as { text: string }).text);
    expect(prompts.filter((p) => p === "sent while offline")).toHaveLength(1);
  }, 120_000);
});

describe("hub state follows the owner's events (S5)", () => {
  let wt = "";
  const chatId = "status-chat";

  beforeAll(async () => {
    wt = await w.createWorktree(owner, "proj", "feat-status");
  }, 60_000);

  it("shows done after a turn, with its usage and a turn checkpoint", async () => {
    const events = await w.turn(wt, chatId, "usage please");
    expect(events.find(turnEnded)).toMatchObject({ usage: { costUsd: 0.42 } });
    const state = await w.q<{ state: { usage: { used: number } | null } }>("chats.sessionState", {
      chatId,
    });
    expect(state.state.usage?.used).toBe(1200);
    await waitFor(async () => ((await worktreeStatus(wt)) === "done" ? true : undefined), {
      label: "status done",
      timeoutMs: 10_000,
    });
    await waitFor(
      async () => ((await w.checkpoints(wt)).checkpoints.length > 0 ? true : undefined),
      { label: "a turn checkpoint", timeoutMs: 30_000 },
    );
    expect((await w.checkpoints(wt)).checkpoints[0]?.trigger).toBe("turn");
    const tasks = await w.q<{ tasks: Array<{ chatId: string; status: string; prompt: string }> }>(
      "tasks.list",
      { worktreeId: wt },
    );
    expect(tasks.tasks.find((t) => t.chatId === chatId)).toMatchObject({
      status: "completed",
      prompt: "usage please",
    });
    await w.m("statuses.clearNeedsAttention", { worktreeId: wt });
    expect(await worktreeStatus(wt)).toBe("idle");
  }, 90_000);

  it("shows a question while the agent waits, and done once the hub forwards the answer", async () => {
    let requestId = "";
    const after = maxId(await w.turn(wt, chatId, "usage again"));
    const stream = await openStream(w.server.url, chatId, {
      lastEventId: after,
      until: (e) => turnEnded(e) && e.eventId > after,
      onEvent: (e) => {
        if (e.type === "permission") requestId = e.requestId;
      },
      timeoutMs: 60_000,
    });
    await sendViaHub(wt, chatId, "ask first");
    await waitFor(async () => ((await worktreeStatus(wt)) === "question" ? true : undefined), {
      label: "status question",
      timeoutMs: 20_000,
    });
    await waitFor(() => (requestId ? true : undefined), { label: "the permission event" });
    await w.m("chat.answer", { chatId, requestId, optionId: "allow" });
    const events = await stream.events;
    expect(agentText(events)).toContain("Allowed and ran.");
    await waitFor(async () => ((await worktreeStatus(wt)) === "done" ? true : undefined), {
      label: "status done after the answer",
      timeoutMs: 20_000,
    });
  }, 120_000);
});

describe("restore while the owner is offline (S6)", () => {
  it("continues the chat on another host from the hub's copy and the checkpoint", async () => {
    const wt = await w.createWorktree(owner, "proj", "feat-restore");
    const chatId = "restore-chat";
    await w.turn(wt, chatId, "remember: mango");
    await waitFor(
      async () => ((await w.checkpoints(wt)).checkpoints.length > 0 ? true : undefined),
      { label: "a checkpoint to restore from", timeoutMs: 30_000 },
    );
    const sessionId = (await getChat(chatId))?.activeSessionId;
    await w.killWorker(owner);

    const result = await w.m<{ worktreeId: string }>("checkpoints.restore", {
      worktreeId: wt,
      toHostId: plain.hostId,
    });
    const restored = result.worktreeId;
    const chat = await getChat(chatId);
    expect(chat?.ownerHostId).toBeUndefined();
    expect(chat?.activeSessionId).toBe(sessionId);

    const events = await w.turn(restored, chatId, "what was it?");
    expect(agentText(events)).toContain("what was it?");
    // Resumed, not replaced: the checkpoint carried the agent's session files.
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect((await getChat(chatId))?.activeSessionId).toBe(sessionId);
    // The hub's copy holds the turn that ran on the owner, and the new host resumed that session.
    const replay = await openStream(w.server.url, chatId, {
      until: (e: ChatEvent) => e.type === "history-meta",
      timeoutMs: 10_000,
    });
    const prompts = (await replay.events)
      .filter((e) => e.type === "prompt")
      .map((e) => (e.type === "prompt" ? e.text : ""));
    expect(prompts).toEqual(expect.arrayContaining(["remember: mango", "what was it?"]));
    const resumed = [
      ...w.stubRequests(plain, "session/resume"),
      ...w.stubRequests(plain, "session/load"),
    ].filter((r) => r.params.sessionId === sessionId);
    expect(resumed.length).toBeGreaterThan(0);

    owner = await w.restartWorker(owner);
  }, 150_000);
});
