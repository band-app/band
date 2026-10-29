// Integration tests for opening an old agent session (one Band has no log for) in a chat a worker
// owns: the history loads before it is shown, instead of replaying live under the first prompt.
// A real hub and a real `band-worker --own-chats`; the coding agent is the scripted ACP stub, which
// replays a saved session on `session/load`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "@band-app/shared/chat-events";
import type { DirectAccess } from "@band-app/shared/direct-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentText, openStream } from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";

let w: World;
let owner: Worker;
let wt = "";
let access: DirectAccess;

const direct = () => `http://127.0.0.1:${access.port}`;
const bearer = () => ({ Authorization: `Bearer ${access.token}` });

/** Saves a session in the stub agent's history, the way an earlier run of the agent would have. */
function seedSession(sessionId: string) {
  mkdirSync(owner.stubState, { recursive: true });
  const chunk = (kind: string, text: string) => ({
    sessionUpdate: kind,
    content: { type: "text", text },
  });
  writeFileSync(
    join(owner.stubState, `${sessionId}.json`),
    JSON.stringify({
      cwd: "",
      title: "old session",
      updatedAt: new Date().toISOString(),
      model: "stub-small",
      mode: "default",
      history: [
        chunk("user_message_chunk", "old question"),
        chunk("agent_message_chunk", "old answer"),
        chunk("user_message_chunk", "second question"),
        chunk("agent_message_chunk", "second answer"),
      ],
    }),
  );
}

async function newChat(chatId: string, sessionId: string) {
  await w.m("chats.create", { worktreeId: wt, id: chatId, name: "Old" });
  await w.m("chats.setActiveSession", { worktreeId: wt, chatId, sessionId });
}

/** The chat's stream until the window ends, then a short while longer for stray live events. */
async function openCold(base: string, chatId: string, headers?: Record<string, string>) {
  const stream = await openStream(base, chatId, {
    headers,
    until: (e) => e.type === "history-meta",
    timeoutMs: 60_000,
  });
  return stream.events;
}

const replayed = (events: ChatEvent[]) =>
  events.filter(
    (e) =>
      e.type === "update" &&
      (e.update.sessionUpdate === "user_message_chunk" ||
        e.update.sessionUpdate === "agent_message_chunk"),
  );

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
  owner = await w.addWorker("owner", ["proj"], { ownChats: true });
  wt = await w.createWorktree(owner, "proj", "feat-view");
  const issued = await w.m<DirectAccess | null>("worktree.directAccess", {
    worktreeId: wt,
    hostId: owner.hostId,
  });
  if (!issued) throw new Error("the worker offered no direct path");
  access = issued;
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("an old session in a chat its worker owns", () => {
  it("S1: the direct stream sends the history as one window before history-meta", async () => {
    seedSession("old-direct");
    await newChat("view-direct", "old-direct");
    const events = await openCold(direct(), "view-direct", bearer());
    const meta = events.findIndex((e) => e.type === "history-meta");
    const before = replayed(events.slice(0, meta));
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(agentText(events)).toContain("second answer");
    expect(replayed(events.slice(meta + 1))).toHaveLength(0);
    expect(w.stubRequests(owner, "session/load").length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("S2: the hub's stream sends the history as one window", async () => {
    seedSession("old-hub");
    await newChat("view-hub", "old-hub");
    const events = await openCold(w.server.url, "view-hub", {
      Cookie: "band_token=acp-chat-test-token",
    });
    const meta = events.findIndex((e) => e.type === "history-meta");
    expect(agentText(events.slice(0, meta))).toContain("second answer");
    expect(replayed(events.slice(meta + 1))).toHaveLength(0);
  }, 90_000);

  it("S3: the first prompt after viewing does not load the session again", async () => {
    seedSession("old-prompt");
    await newChat("view-prompt", "old-prompt");
    await openCold(direct(), "view-prompt", bearer());
    const loadsBefore = w
      .stubRequests(owner, "session/load")
      .filter((r) => (r.params as { sessionId: string }).sessionId === "old-prompt").length;
    expect(loadsBefore).toBe(1);

    const res = await fetch(`${direct()}/api/chats/view-prompt/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer() },
      body: JSON.stringify({ worktreeId: wt, text: "continue" }),
    });
    expect(res.ok).toBe(true);
    const after = await openStream(direct(), "view-prompt", {
      headers: bearer(),
      until: (e) => e.type === "turn-ended",
      timeoutMs: 60_000,
    });
    const loads = w
      .stubRequests(owner, "session/load")
      .filter((r) => (r.params as { sessionId: string }).sessionId === "old-prompt");
    expect(loads).toHaveLength(1);
    const afterEvents = await after.events;
    expect(agentText(afterEvents)).toContain("second answer");
    expect(agentText(afterEvents)).toContain("continue");
  }, 90_000);

  it("S4: a failing load gives a notice and does not start a new session", async () => {
    // No saved session of that id: the stub answers resource-not-found to load and resume.
    await newChat("view-fail", "never-existed");
    const sessionsBefore = w.stubRequests(owner, "session/new").length;
    const events = await openStream(direct(), "view-fail", {
      headers: bearer(),
      // The notice follows the (empty) window on the live queue.
      until: (e) => e.type === "notice",
      timeoutMs: 60_000,
    }).then((s) => s.events);
    expect(events.some((e) => e.type === "history-meta")).toBe(true);
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toMatchObject({ level: "warning" });
    expect(JSON.stringify(notice)).toContain("history couldn't be loaded");
    expect(w.stubRequests(owner, "session/new")).toHaveLength(sessionsBefore);
  }, 90_000);
});
