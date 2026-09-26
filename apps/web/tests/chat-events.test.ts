/**
 * The chat event stream and the submit endpoint, end to end (issue #648):
 *
 *   GET  /api/chats/:chatId/events    SSE: `id: <eventId>`, `event: <type>`,
 *                                     `data: <ChatEvent JSON>` frames
 *   POST /api/chats/:chatId/messages  submit a message (starts or queues a turn)
 *
 * Boots the real server bundle with every coding agent pointed at the
 * scripted stub ACP agent (`startAcpServer`), so a turn runs over the real
 * Agent Client Protocol. Assertions read the stream, tRPC and the stub's
 * request log (what Band sent the agent). The wire schema is
 * `src/shared/chat-events.ts`.
 *
 * `acp-chat.test.ts` covers the ACP-specific paths (permissions,
 * elicitations, config options, session load / resume, agent failures).
 * This file covers the stream and submit contracts: subscribe snapshots,
 * framing, the turn's event sequence, gap-fill reconnects, concurrent
 * subscribers, stream close, the queue, attachments, cancel, session
 * switching, auth and input validation. History windows and paging are in
 * `chat-history.test.ts`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/shared/chat-events";
import {
  agentText,
  collectEvents,
  maxId,
  openStream,
  runTurn,
  sendMessage,
  startAcpServer,
  stubRequests,
  TEST_TOKEN,
  trpc,
  turnEnded,
  WORKSPACE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";
import { listTasksForWorkspace } from "./helpers/tasks";

const authHeaders = { Cookie: `band_token=${TEST_TOKEN}` };

// One server for the whole file; each test uses its own chat. The stub
// picks a turn by the prompt's first word.
let server: ServerHandle;

beforeAll(async () => {
  server = await startAcpServer({
    turns: [
      { match: "^slow", steps: [{ sleep: 400 }, { say: "slow done" }] },
      { match: "^wait", steps: [{ say: "Working." }, { waitForCancel: true }] },
      { match: "^chunky", steps: [{ say: "one two three four", chunks: 4 }] },
      {
        match: "^ask",
        steps: [
          {
            permission: {
              toolCall: { toolCallId: "edit-1", title: "Edit README.md", kind: "edit" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
            after: { allow: [{ say: "Edited." }] },
          },
        ],
      },
    ],
  });
}, 30_000);

afterAll(async () => {
  await server?.close();
});

let seq = 0;
const newChatId = (tag = "chat") => `events-${tag}-${Date.now()}-${seq++}`;

const logged = (events: ChatEvent[]) => events.filter((e) => e.eventId > 0);

interface Frame {
  id: string;
  event: string;
  data: ChatEvent;
}

/**
 * Reads raw SSE frames until the server ends the stream or `timeoutMs`
 * passes. `ended` says which happened.
 */
async function readFrames(
  chatId: string,
  opts: {
    headers?: Record<string, string>;
    query?: string;
    timeoutMs: number;
    onFrame?: (frame: Frame) => void;
  },
): Promise<{ frames: Frame[]; ended: boolean }> {
  const ac = new AbortController();
  const res = await fetch(
    `${server.url}/api/chats/${encodeURIComponent(chatId)}/events${opts.query ?? ""}`,
    { headers: { ...authHeaders, ...opts.headers }, signal: ac.signal },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  let ended = false;
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf("\n\n");
        const field = (name: string) =>
          block
            .split("\n")
            .find((l) => l.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const data = field("data");
        if (data) {
          const frame = {
            id: field("id") ?? "",
            event: field("event") ?? "",
            data: JSON.parse(data),
          };
          frames.push(frame);
          opts.onFrame?.(frame);
        }
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { frames, ended };
}

/**
 * Starts {@link readFrames} and waits until a frame of type `readyOn` has
 * arrived, so a message sent afterwards is seen live.
 */
async function openFrames(
  chatId: string,
  opts: Parameters<typeof readFrames>[1],
  readyOn = "subscription-opened",
): Promise<{ result: ReturnType<typeof readFrames> }> {
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = readFrames(chatId, {
    ...opts,
    onFrame: (f) => {
      if (f.data.type === readyOn) ready();
    },
  });
  await Promise.race([isReady, result]);
  return { result };
}

// ---------------------------------------------------------------------------

describe("subscribe", () => {
  it("opens immediately for a fresh chat with the snapshot events", async () => {
    const chatId = newChatId("fresh");
    const events = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "history-meta",
      timeoutMs: 5_000,
    });
    expect(events.map((e) => e.type)).toEqual([
      "subscription-opened",
      "queue-updated",
      "session-state",
      "history-meta",
    ]);
    expect(events[0]).toMatchObject({ taskRunning: false, revision: 0, reset: false });
    expect(events[0].type === "subscription-opened" && events[0].sessionId).toBeUndefined();
    // Always sent, even when empty, so a reconnecting client drops a stale
    // queue (the queue drained while it was away).
    expect(events[1]).toMatchObject({ type: "queue-updated", messages: [] });
    // A chat with no session gets the default agent's catalog.
    expect(events[2]).toMatchObject({ type: "session-state", state: { source: "cached" } });
    expect(events[3]).toMatchObject({ hasOlder: false, oldestEventId: 0 });
    // Synthetic events never move the client's cursor.
    expect(events.every((e) => e.eventId < 0)).toBe(true);
  });

  it("frames each event with its id and type on the SSE lines", async () => {
    const chatId = newChatId("frames");
    await runTurn(server.url, chatId, "hello frames");
    const { frames } = await readFrames(chatId, { timeoutMs: 1_000 });
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) {
      // Logged events carry their id; synthetic ones (negative ids) have no
      // `id:` line, so they never move the browser's Last-Event-ID.
      expect(f.id).toBe(f.data.eventId > 0 ? String(f.data.eventId) : "");
      expect(f.event).toBe(f.data.type);
    }
    expect(frames.some((f) => f.id === "")).toBe(true);
  });
});

describe("a turn", () => {
  it("submit then observe: the logged sequence of a first turn", async () => {
    const chatId = newChatId("sequence");
    const { events: done } = await openStream(server.url, chatId, { until: turnEnded });
    const submit = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, text: "hello" }),
    });
    expect(submit.status).toBe(200);
    expect(await submit.json()).toEqual({ ok: true, queued: false });
    const events = await done;

    const kinds = logged(events).map((e) =>
      e.type === "update" ? `update:${e.update.sessionUpdate}` : e.type,
    );
    expect(kinds).toEqual([
      "session-attached",
      "update:available_commands_update",
      "prompt",
      "turn-started",
      "update:agent_message_chunk",
      "turn-ended",
    ]);
    // Logged ids only grow.
    const ids = logged(events).map((e) => e.eventId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(events.find((e) => e.type === "prompt")).toMatchObject({ text: "hello" });
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", stopReason: "end_turn" });

    // The chat row now points at the agent's session.
    const attached = events.find((e) => e.type === "session-attached");
    const { chat } = await trpc<{ chat: { activeSessionId?: string; status: string } }>(
      server.url,
      "chats.get",
      { chatId },
      "query",
    );
    expect(chat.activeSessionId).toBe(
      attached?.type === "session-attached" ? attached.sessionId : "missing",
    );
  });

  it("the prompt event carries what the user typed; the agent also gets the file-sharing hint on the first turn only", async () => {
    const chatId = newChatId("hint");
    const first = await runTurn(server.url, chatId, "first message");
    const second = await runTurn(server.url, chatId, "second message", maxId(first));
    expect(first.find((e) => e.type === "prompt")).toMatchObject({ text: "first message" });
    expect(second.find((e) => e.type === "prompt")).toMatchObject({ text: "second message" });

    const sent = stubRequests(server.home, "session/prompt")
      .map((r) => r.params.prompt as { type: string; text?: string }[])
      .filter((blocks) => ["first message", "second message"].includes(blocks[0].text ?? ""));
    expect(sent).toHaveLength(2);
    expect(sent[0][0]).toEqual({ type: "text", text: "first message" });
    expect(sent[0].at(-1)?.text).toMatch(
      /^\[File sharing: to send a file to the user, write or copy it to .*\/shared\//,
    );
    expect(sent[1]).toEqual([{ type: "text", text: "second message" }]);
  });

  it("sequential submits continue the same agent session", async () => {
    const chatId = newChatId("resume");
    const first = await runTurn(server.url, chatId, "turn one");
    const second = await runTurn(server.url, chatId, "turn two", maxId(first));

    const attached = first.find((e) => e.type === "session-attached");
    const sessionId = attached?.type === "session-attached" ? attached.sessionId : "";
    // The second turn reuses the attached session: no new attach.
    expect(second.some((e) => e.type === "session-attached")).toBe(false);
    expect(agentText(second)).toBe('Heard "turn two" on stub-small.');
    const prompts = stubRequests(server.home, "session/prompt").filter((r) =>
      ["turn one", "turn two"].includes((r.params.prompt as { text?: string }[])[0].text ?? ""),
    );
    expect(prompts.map((r) => r.params.sessionId)).toEqual([sessionId, sessionId]);
  });

  it("the stream closes after turn-ended when the chat goes idle", async () => {
    const chatId = newChatId("close");
    const { result: reading } = await openFrames(chatId, { timeoutMs: 10_000 });
    await sendMessage(server.url, chatId, "hello close");
    const { frames, ended } = await reading;
    expect(ended).toBe(true);
    expect(frames.at(-1)?.data).toMatchObject({ type: "turn-ended", stopReason: "end_turn" });

    // A stream opened on the idle chat stays open past its snapshot events
    // and until the next turn ends.
    const cursor = Math.max(...frames.map((f) => f.data.eventId));
    const { result: next } = await openFrames(
      chatId,
      { query: `?lastEventId=${cursor}`, timeoutMs: 10_000 },
      "session-state",
    );
    await sendMessage(server.url, chatId, "hello again");
    const again = await next;
    expect(again.ended).toBe(true);
    const kinds = again.frames.map((f) => f.data.type);
    expect(kinds.slice(0, 3)).toEqual(["subscription-opened", "queue-updated", "session-state"]);
    expect(kinds.filter((k) => k === "prompt")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("turn-ended");
  });
});

describe("reconnect", () => {
  it("Last-Event-ID gap-fill sends only what came after the cursor", async () => {
    const chatId = newChatId("gapfill");
    const full = await runTurn(server.url, chatId, "chunky reply");
    const fullLogged = logged(full);
    // Resume from the middle of the reply's chunks.
    const chunks = fullLogged.filter(
      (e) => e.type === "update" && e.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks).toHaveLength(4);
    const cursor = chunks[1].eventId;

    const { frames } = await readFrames(chatId, {
      headers: { "Last-Event-ID": String(cursor) },
      timeoutMs: 1_000,
    });
    const replay = frames.map((f) => f.data);
    expect(replay[0]).toMatchObject({ type: "subscription-opened", reset: false });
    const replayLogged = logged(replay);
    expect(replayLogged.every((e) => e.eventId > cursor)).toBe(true);
    // The two chunks after the cursor come back merged, then the turn end.
    expect(agentText(replayLogged)).toBe(agentText(chunks.slice(2)));
    expect(replayLogged.at(-1)).toMatchObject({ type: "turn-ended" });
    // No history-meta on a gap-fill: the client keeps what it has.
    expect(replay.some((e) => e.type === "history-meta")).toBe(false);
  });

  it("a cold subscribe then a reconnect at its last id re-sends nothing", async () => {
    const chatId = newChatId("nodup");
    await runTurn(server.url, chatId, "hello nodup");
    const cold = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "history-meta",
    });
    // The cold replay carries the logged (positive) ids.
    expect(logged(cold).length).toBeGreaterThan(0);
    const opened = cold[0];
    const revision = opened.type === "subscription-opened" ? opened.revision : -1;

    const { frames } = await readFrames(chatId, {
      query: `?lastEventId=${maxId(cold)}&revision=${revision}`,
      timeoutMs: 1_000,
    });
    // Positive anchor: the snapshot events arrived.
    expect(frames.map((f) => f.data.type)).toEqual([
      "subscription-opened",
      "queue-updated",
      "session-state",
    ]);
    expect(logged(frames.map((f) => f.data))).toEqual([]);
  });

  it("two concurrent subscribers receive the same logged events", async () => {
    const chatId = newChatId("concurrent");
    const a = await openStream(server.url, chatId, { until: turnEnded });
    const b = await openStream(server.url, chatId, { until: turnEnded });
    await sendMessage(server.url, chatId, "chunky for two");
    const [eventsA, eventsB] = await Promise.all([a.events, b.events]);
    expect(logged(eventsA).length).toBeGreaterThan(4);
    expect(logged(eventsA)).toEqual(logged(eventsB));
  });

  it("a permission request is logged once, live and on replay", async () => {
    const chatId = newChatId("permission");
    const answers: Promise<unknown>[] = [];
    const { events: done } = await openStream(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "permission") {
          answers.push(
            trpc(server.url, "chat.answer", {
              chatId,
              requestId: e.requestId,
              optionId: "allow",
            }),
          );
        }
      },
    });
    await sendMessage(server.url, chatId, "ask first");
    const live = await done;
    await Promise.all(answers);
    expect(live.filter((e) => e.type === "permission")).toHaveLength(1);
    expect(agentText(live)).toBe("Edited.");

    const replay = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "history-meta",
    });
    const kinds = logged(replay).map((e) => e.type);
    expect(kinds.filter((k) => k === "permission")).toHaveLength(1);
    expect(kinds.indexOf("request-resolved")).toBeGreaterThan(kinds.indexOf("permission"));
  });
});

describe("queue", () => {
  it("a message sent during a turn is queued, then runs as its own clean turn", async () => {
    const chatId = newChatId("queue");
    const { events: done } = await openStream(server.url, chatId, {
      until: (_e, all) => all.filter(turnEnded).length === 2,
    });
    expect(await sendMessage(server.url, chatId, "slow first")).toEqual({
      ok: true,
      queued: false,
    });
    expect(await sendMessage(server.url, chatId, "queued second")).toEqual({
      ok: true,
      queued: true,
    });
    const events = await done;

    const queues = events
      .filter((e) => e.type === "queue-updated")
      .map((e) => (e.type === "queue-updated" ? e.messages.map((m) => m.text) : []));
    // Initial snapshot, the queued message, then drained.
    expect(queues).toEqual([[], ["queued second"], []]);

    // Two turns, each prompt → turn-started → reply → turn-ended, in order.
    const turnKinds = logged(events)
      .filter((e) => ["prompt", "turn-started", "turn-ended"].includes(e.type))
      .map((e) => (e.type === "prompt" ? `prompt:${e.text}` : e.type));
    expect(turnKinds).toEqual([
      "prompt:slow first",
      "turn-started",
      "turn-ended",
      "prompt:queued second",
      "turn-started",
      "turn-ended",
    ]);
    expect(agentText(events)).toBe('slow doneHeard "queued second" on stub-small.');
  });

  it("a drained queued message keeps its image attachment", async () => {
    const chatId = newChatId("queue-files");
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const uploadDir = join(server.home, ".band", "uploads");
    const before = new Set(existsSync(uploadDir) ? readdirSync(uploadDir) : []);

    const { events: done } = await openStream(server.url, chatId, {
      until: (_e, all) => all.filter(turnEnded).length === 2,
    });
    await sendMessage(server.url, chatId, "slow start");
    expect(
      await sendMessage(server.url, chatId, "look at this pixel", {
        files: [
          {
            mediaType: "image/png",
            url: `data:image/png;base64,${pixel.toString("base64")}`,
            filename: "queued-pixel.png",
          },
        ],
      }),
    ).toMatchObject({ queued: true });
    const events = await done;

    const drained = events.filter((e) => e.type === "prompt").at(-1);
    expect(drained?.type === "prompt" && drained.text).toBe("look at this pixel");
    const files = drained?.type === "prompt" ? drained.files : undefined;
    expect(files).toEqual([
      {
        mediaType: "image/png",
        url: expect.stringMatching(/^\/api\/uploads\/.*queued-pixel\.png$/),
        filename: "queued-pixel.png",
      },
    ]);

    // Saved once, bytes intact (the drain doesn't re-upload).
    const added = readdirSync(uploadDir).filter((f) => !before.has(f));
    expect(added).toHaveLength(1);
    expect(Buffer.compare(readFileSync(join(uploadDir, added[0])), pixel)).toBe(0);

    // The agent (which accepts images) got the picture itself.
    const sent = stubRequests(server.home, "session/prompt").find(
      (r) => (r.params.prompt as { text?: string }[])[0].text === "look at this pixel",
    );
    const blocks = sent?.params.prompt as { type: string; mimeType?: string; data?: string }[];
    expect(blocks.find((b) => b.type === "image")).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: pixel.toString("base64"),
    });
  });
});

describe("attachments", () => {
  it("saves an uploaded file to disk and shows it on the prompt by its /api/uploads URL", async () => {
    const chatId = newChatId("upload");
    const { events: done } = await openStream(server.url, chatId, { until: turnEnded });
    await sendMessage(server.url, chatId, "read my notes", {
      files: [
        {
          mediaType: "text/plain",
          url: `data:text/plain;base64,${Buffer.from("my notes").toString("base64")}`,
          filename: "notes.txt",
        },
      ],
    });
    const events = await done;
    const prompt = events.find((e) => e.type === "prompt");
    const file = prompt?.type === "prompt" ? prompt.files?.[0] : undefined;
    expect(file).toMatchObject({ mediaType: "text/plain", filename: "notes.txt" });
    expect(file?.url).toMatch(/^\/api\/uploads\//);

    // The URL serves the bytes that were uploaded.
    const res = await fetch(`${server.url}${file?.url}`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("my notes");
  });
});

describe("cancel", () => {
  it("tasks.abort ends the running turn as cancelled and fails the task", async () => {
    const chatId = newChatId("abort");
    const answers: Promise<unknown>[] = [];
    const { events: done } = await openStream(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        // Abort once the agent is inside the turn.
        if (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk") {
          answers.push(trpc(server.url, "tasks.abort", { workspaceId: WORKSPACE_ID, chatId }));
        }
      },
    });
    await sendMessage(server.url, chatId, "wait for me");
    const events = await done;
    await Promise.all(answers);

    expect(agentText(events)).toBe("Working.");
    const ended = events.at(-1);
    expect(ended).toMatchObject({ type: "turn-ended", stopReason: "cancelled" });
    const taskId = ended?.type === "turn-ended" ? ended.taskId : "";
    const tasks = await listTasksForWorkspace(server.url, WORKSPACE_ID, TEST_TOKEN);
    expect(tasks.find((t) => t.id === taskId)?.status).toBe("failed");
  });

  // Known bug (issue #648 review): a Stop that lands while the agent is
  // still starting is dropped. `agentSessionService.cancel` returns early
  // when the chat has no process / session yet, `abortTask` still reports
  // success, and the turn then runs to completion (here: forever, since
  // this turn waits for a cancel). Fails until the service remembers the
  // cancel and applies it once the session is attached.
  it("tasks.abort sent while the agent is still starting cancels the turn", async () => {
    const chatId = newChatId("abort-early");
    const { events: done } = await openStream(server.url, chatId, {
      until: turnEnded,
      timeoutMs: 8_000,
    });
    await sendMessage(server.url, chatId, "wait for me early");
    // Straight after the submit returns: the agent process is not up yet.
    await trpc(server.url, "tasks.abort", { workspaceId: WORKSPACE_ID, chatId });
    const events = await done;
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", stopReason: "cancelled" });
  });
});

describe("session switching", () => {
  it("a cold subscribe follows chat.activeSessionId, not the last task's session", async () => {
    const chatId = newChatId("switch");
    const turn = await runTurn(server.url, chatId, "first task");
    const attached = turn.find((e) => e.type === "session-attached");
    const oldSession = attached?.type === "session-attached" ? attached.sessionId : "";

    const otherSessionId = "session-picked-from-history";
    await trpc(server.url, "chats.setActiveSession", {
      workspaceId: WORKSPACE_ID,
      chatId,
      sessionId: otherSessionId,
    });

    const events = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "history-meta",
    });
    expect(events[0]).toMatchObject({
      type: "subscription-opened",
      sessionId: otherSessionId,
      taskRunning: false,
    });
    expect(oldSession).not.toBe(otherSessionId);
    // Nothing from the previous session is replayed.
    expect(events.some((e) => e.type === "prompt")).toBe(false);
  });

  it("clearing activeSessionId (New session) yields an empty subscription", async () => {
    const chatId = newChatId("newsession");
    await runTurn(server.url, chatId, "first task");
    await trpc(server.url, "chats.setActiveSession", { workspaceId: WORKSPACE_ID, chatId });

    const events = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "history-meta",
    });
    expect(events[0]).toMatchObject({ type: "subscription-opened", revision: 0 });
    expect(events[0].type === "subscription-opened" && events[0].sessionId).toBeUndefined();
    expect(logged(events)).toEqual([]);

    // The next message starts a fresh session.
    const next = await runTurn(server.url, chatId, "new beginning");
    expect(next.find((e) => e.type === "session-attached")).toMatchObject({ how: "new" });
  });
});

describe("error paths", () => {
  it("submitting to a workspace that doesn't exist returns 404; the chat's stream still opens", async () => {
    const chatId = newChatId("orphan-ws");
    const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ workspaceId: "no-such-workspace-main", text: "hello" }),
    });
    expect(res.status).toBe(404);

    const events = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "history-meta",
      timeoutMs: 5_000,
    });
    expect(events[0]).toMatchObject({ type: "subscription-opened", taskRunning: false });
  });

  it("GET /api/chats/:chatId/events without band_token cookie is rejected (401)", async () => {
    const res = await fetch(`${server.url}/api/chats/${newChatId("auth")}/events`);
    expect(res.status).toBe(401);
  });

  it("POST /api/chats/:chatId/messages without band_token cookie is rejected (401)", async () => {
    const res = await fetch(`${server.url}/api/chats/${newChatId("auth")}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, text: "anything" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/chats/:chatId/messages with missing workspaceId returns 400", async () => {
    const res = await fetch(`${server.url}/api/chats/${newChatId("bad")}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ text: "no workspace id" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "workspaceId and text are required" });
  });

  it("POST /api/chats/:chatId/messages with blank text returns 400", async () => {
    const res = await fetch(`${server.url}/api/chats/${newChatId("bad")}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, text: "   " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "workspaceId and text are required" });
  });

  it("POST /api/chats/:chatId/messages with a non-JSON body returns 400", async () => {
    const res = await fetch(`${server.url}/api/chats/${newChatId("bad")}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: "this is not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});
