/**
 * Chat over the Agent Client Protocol, end to end (issue #648).
 *
 * Boots the real server with every coding agent pointed at the scripted
 * stub ACP agent (`tests/fixtures/acp-stub-agent.mjs`) and drives chats
 * through the public HTTP surface: `POST /api/chats/:id/messages`, the
 * `GET /api/chats/:id/events` SSE stream and tRPC. Assertions read the
 * stream and the stub's own request log (what Band sent over ACP).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/shared/chat-events";
import {
  agentText,
  collectEvents,
  sendMessage,
  startAcpServer,
  stubRequests,
  trpc,
  turnEnded,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

let servers: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function boot(opts: Parameters<typeof startAcpServer>[0] = {}) {
  const server = await startAcpServer(opts);
  servers.push(server);
  return server;
}

let seq = 0;
const newChatId = () => `acp-chat-${Date.now()}-${seq++}`;

/** Sends `text` and collects the stream until the turn ends. */
async function runTurn(url: string, chatId: string, text: string, lastEventId?: number) {
  const events = collectEvents(url, chatId, {
    lastEventId,
    // A turn that fails before the chat has a session ends with a
    // transient (negative-id) event.
    until: (e) => turnEnded(e) && (e.eventId > (lastEventId ?? 0) || e.eventId < 0),
  });
  await new Promise((r) => setTimeout(r, 50));
  await sendMessage(url, chatId, text);
  return events;
}

const maxId = (events: ChatEvent[]) => Math.max(0, ...events.map((e) => e.eventId));

describe("chat over ACP", () => {
  it("streams the agent's reply as ACP session/updates and logs the prompt", async () => {
    const server = await boot();
    const chatId = newChatId();

    const events = await runTurn(server.url, chatId, "hello there");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("subscription-opened");
    expect(types).toContain("session-attached");
    const prompt = events.find((e) => e.type === "prompt");
    expect(prompt).toMatchObject({ type: "prompt", text: "hello there" });
    expect(agentText(events)).toBe('Heard "hello there" on stub-small.');
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", stopReason: "end_turn" });

    // What Band told the agent: no fs, no terminal (#649), form elicitation.
    const [init] = stubRequests(server.home, "initialize");
    expect(init.params.clientCapabilities).toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      elicitation: { form: {} },
    });
    // The agent runs in the workspace, with chat dispatch for nested `band`
    // calls. (Other `session/new`s come from the boot-time model probe,
    // which runs in `~/.band`.)
    const newSession = stubRequests(server.home, "session/new").find(
      (r) => r.params.cwd === `${server.home}/repo`,
    );
    expect(newSession?.env.BAND_DISPATCH).toBe("chat");
    const [sent] = stubRequests(server.home, "session/prompt");
    const blocks = sent.params.prompt as { type: string; text?: string }[];
    expect(blocks[0]).toEqual({ type: "text", text: "hello there" });
  });

  it("replays a finished chat with text chunks merged, and gap-fills after a cursor", async () => {
    const server = await boot({
      turns: [{ steps: [{ say: "one two three four five six", chunks: 6 }] }],
    });
    const chatId = newChatId();
    const first = await runTurn(server.url, chatId, "count");
    const chunks = first.filter(
      (e) => e.type === "update" && e.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks.length).toBe(6);

    // Cold subscribe: the six chunks come back as one event.
    const replay = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "history-meta",
    });
    const merged = replay.filter(
      (e) => e.type === "update" && e.update.sessionUpdate === "agent_message_chunk",
    );
    expect(merged).toHaveLength(1);
    expect(agentText(merged)).toBe("one two three four five six");
    expect(replay.find((e) => e.type === "history-meta")).toMatchObject({ hasOlder: false });

    // Reconnect with a cursor: only what came after it.
    const opened = replay.find((e) => e.type === "subscription-opened");
    const cursor = maxId(first);
    const second = await runTurn(server.url, chatId, "again", cursor);
    const logged = second.filter((e) => e.eventId > 0);
    expect(logged.every((e) => e.eventId > cursor)).toBe(true);
    // Live chunks arrive as the agent sent them; only replays merge.
    expect([...new Set(logged.map((e) => e.type))]).toEqual([
      "prompt",
      "turn-started",
      "update",
      "turn-ended",
    ]);
    expect(opened).toMatchObject({ reset: false });
  });

  it("answers a permission request with the picked option", async () => {
    const server = await boot({
      turns: [
        {
          steps: [
            {
              permission: {
                toolCall: { toolCallId: "edit-1", title: "Edit README.md", kind: "edit" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
              },
              after: { allow: [{ say: "Edited." }], reject: [{ say: "Skipped." }] },
            },
          ],
        },
      ],
    });
    const chatId = newChatId();
    const done = collectEvents(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "permission") {
          void trpc(server.url, "chat.answer", {
            chatId,
            requestId: e.requestId,
            optionId: "allow",
          });
        }
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await sendMessage(server.url, chatId, "edit it");
    const events = await done;

    const permission = events.find((e) => e.type === "permission");
    expect(permission).toMatchObject({
      request: { toolCall: { title: "Edit README.md" } },
    });
    expect(events.find((e) => e.type === "request-resolved")).toMatchObject({ answer: "allow" });
    expect(agentText(events)).toBe("Edited.");
  });

  it("answers a form elicitation (AskUserQuestion) with the user's choice", async () => {
    const server = await boot({
      turns: [
        {
          steps: [
            {
              elicitation: {
                message: "Which database?",
                requestedSchema: {
                  type: "object",
                  properties: {
                    question_0: {
                      type: "string",
                      oneOf: [
                        { const: "Postgres", title: "Postgres" },
                        { const: "SQLite", title: "SQLite" },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    });
    const chatId = newChatId();
    const done = collectEvents(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "elicitation") {
          void trpc(server.url, "chat.answerElicitation", {
            chatId,
            requestId: e.requestId,
            action: "accept",
            content: { question_0: "SQLite" },
          });
        }
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await sendMessage(server.url, chatId, "pick one");
    const events = await done;
    expect(events.find((e) => e.type === "elicitation")).toMatchObject({
      request: { mode: "form", message: "Which database?" },
    });
    expect(events.find((e) => e.type === "request-resolved")).toMatchObject({ answer: "accept" });
    expect(agentText(events)).toBe('Answer: {"question_0":"SQLite"}');
  });

  it("stops a turn with session/cancel and cancels its open permission request", async () => {
    const server = await boot({
      turns: [
        {
          steps: [
            { say: "Working on it." },
            {
              permission: {
                toolCall: { toolCallId: "run-1", title: "Run tests", kind: "execute" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              },
            },
          ],
        },
      ],
    });
    const chatId = newChatId();
    const done = collectEvents(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "permission") {
          void trpc(server.url, "tasks.abort", { workspaceId: "testproject-main", chatId });
        }
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await sendMessage(server.url, chatId, "run the tests");
    const events = await done;

    expect(events.find((e) => e.type === "request-resolved")).toMatchObject({
      answer: "cancelled",
    });
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", stopReason: "cancelled" });
    expect(stubRequests(server.home, "session/cancel")).toHaveLength(1);
  });

  it("queues a message sent during a turn and runs it after", async () => {
    const server = await boot({
      turns: [
        { match: "^slow", steps: [{ sleep: 400 }, { say: "slow done" }] },
        { steps: [{ say: "fast done" }] },
      ],
    });
    const chatId = newChatId();
    const done = collectEvents(server.url, chatId, {
      until: (_e, all) => all.filter(turnEnded).length === 2,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await sendMessage(server.url, chatId, "slow one")).toMatchObject({ queued: false });
    expect(await sendMessage(server.url, chatId, "second one")).toMatchObject({ queued: true });
    const events = await done;

    const queueUpdates = events.filter((e) => e.type === "queue-updated");
    expect(queueUpdates.some((e) => e.type === "queue-updated" && e.messages.length === 1)).toBe(
      true,
    );
    const prompts = events
      .filter((e) => e.type === "prompt")
      .map((e) => e.type === "prompt" && e.text);
    expect(prompts).toEqual(["slow one", "second one"]);
    expect(agentText(events)).toBe("slow donefast done");
  });

  it("sends attached files as ACP resource links and shows them on the prompt", async () => {
    const server = await boot({ caps: { image: false } });
    const chatId = newChatId();
    const done = collectEvents(server.url, chatId, { until: turnEnded });
    await new Promise((r) => setTimeout(r, 50));
    await sendMessage(server.url, chatId, "look at this", {
      files: [
        {
          mediaType: "text/plain",
          url: `data:text/plain;base64,${Buffer.from("hello file").toString("base64")}`,
          filename: "note.txt",
        },
      ],
    });
    const events = await done;

    const prompt = events.find((e) => e.type === "prompt");
    expect(prompt).toMatchObject({ files: [{ mediaType: "text/plain", filename: "note.txt" }] });
    const [sent] = stubRequests(server.home, "session/prompt");
    const link = (sent.params.prompt as { type: string; uri?: string; name?: string }[]).find(
      (b) => b.type === "resource_link",
    );
    expect(link?.name).toBe("note.txt");
    expect(link?.uri).toMatch(/^file:\/\/.*note/);
  });

  it("changes a session config option on the live session and remembers it", async () => {
    const server = await boot();
    const chatId = newChatId();
    const first = await runTurn(server.url, chatId, "first");

    const { state } = await trpc<{
      state: { configOptions: { id: string; currentValue: string }[] };
    }>(server.url, "chats.setConfigOption", { chatId, configId: "model", value: "stub-large" });
    expect(state.configOptions.find((o) => o.id === "model")?.currentValue).toBe("stub-large");
    expect(stubRequests(server.home, "session/set_config_option")).toHaveLength(1);

    const events = await runTurn(server.url, chatId, "second", maxId(first));
    expect(agentText(events)).toBe('Heard "second" on stub-large.');
    const chat = await trpc<{ chat: { model?: string } }>(
      server.url,
      "chats.get",
      { chatId },
      "query",
    );
    expect(chat.chat.model).toBe("stub-large");
  });

  it("reports an agent that fails to start as an error turn", async () => {
    const server = await boot({ env: { BAND_TEST_ACP_FAIL_START: "Authentication required" } });
    const chatId = newChatId();
    const events = await runTurn(server.url, chatId, "hello");
    const ended = events.find((e) => e.type === "turn-ended");
    expect(ended).toMatchObject({ type: "turn-ended" });
    expect(ended?.type === "turn-ended" && ended.error).toMatch(/Authentication required/);
  });

  it("ends the turn with an error when the agent process dies mid-turn", async () => {
    const server = await boot({
      turns: [{ match: "^crash", steps: [{ say: "about to crash" }, { exit: 3 }] }],
    });
    const chatId = newChatId();
    const events = await runTurn(server.url, chatId, "crash");
    const ended = events.find((e) => e.type === "turn-ended");
    expect(ended?.type === "turn-ended" && ended.error).toBeTruthy();

    // The next message starts a fresh process and reattaches the session.
    const again = await runTurn(server.url, chatId, "still there?", maxId(events));
    expect(agentText(again)).toBe('Heard "still there?" on stub-small.');
    expect(stubRequests(server.home, "session/resume")).toHaveLength(1);
  });
});

describe("chat over ACP: sessions", () => {
  it("resumes the session after a server restart and keeps the log", async () => {
    const first = await boot();
    const home = first.home;
    const chatId = newChatId();
    const turn1 = await runTurn(first.url, chatId, "before restart");
    const opened = turn1.find((e) => e.type === "subscription-opened");
    await first.close();
    servers = servers.filter((s) => s !== first);

    const second = await boot({ home });
    // Reconnecting with the old cursor and revision finds nothing missing.
    const revision = opened?.type === "subscription-opened" ? opened.revision : undefined;
    const reconnect = await collectEvents(second.url, chatId, {
      lastEventId: maxId(turn1),
      revision: 1,
      until: (e) => e.type === "session-state",
    });
    expect(revision).toBe(0);
    expect(reconnect.find((e) => e.type === "subscription-opened")).toMatchObject({
      reset: false,
      revision: 1,
    });
    // A cold subscribe replays the log Band kept.
    const cold = await collectEvents(second.url, chatId, {
      until: (e) => e.type === "history-meta",
    });
    expect(agentText(cold)).toBe('Heard "before restart" on stub-small.');

    // Sending continues the same agent session through session/resume.
    const turn2 = await runTurn(second.url, chatId, "after restart", maxId(cold));
    expect(agentText(turn2)).toBe('Heard "after restart" on stub-small.');
    const [resume] = stubRequests(home, "session/resume");
    const attached = turn1.find((e) => e.type === "session-attached");
    expect(resume.params.sessionId).toBe(
      attached?.type === "session-attached" ? attached.sessionId : "",
    );
  });

  it("loads a session Band never recorded, writing the replay as a new revision", async () => {
    // Session A is started in one chat; chat B then opens it from history.
    const server = await boot();
    const chatA = newChatId();
    const turn = await runTurn(server.url, chatA, "made elsewhere");
    const attached = turn.find((e) => e.type === "session-attached");
    const sessionId = attached?.type === "session-attached" ? attached.sessionId : "";
    await trpc(server.url, "chats.remove", { chatId: chatA });

    const chatB = newChatId();
    await trpc(server.url, "chats.create", { workspaceId: "testproject-main", id: chatB });
    const listed = await trpc<{ sessions: { sessionId: string; summary: string }[] }>(
      server.url,
      "sessions.list",
      { workspaceId: "testproject-main", chatId: chatB },
      "query",
    );
    expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);
    await trpc(server.url, "chats.setActiveSession", {
      workspaceId: "testproject-main",
      chatId: chatB,
      sessionId,
    });

    const events = await collectEvents(server.url, chatB, {
      until: (e) => e.type === "session-attached",
    });
    expect(stubRequests(server.home, "session/load")).toHaveLength(1);
    const userChunk = events.find(
      (e) => e.type === "update" && e.update.sessionUpdate === "user_message_chunk",
    );
    expect(userChunk).toBeTruthy();
    expect(agentText(events)).toBe('Heard "made elsewhere" on stub-small.');

    // A client still holding revision 0 events gets a reset.
    const reconnect = await collectEvents(server.url, chatB, {
      lastEventId: 1,
      revision: 0,
      until: (e) => e.type === "history-meta",
    });
    expect(reconnect[0]).toMatchObject({ type: "subscription-opened", reset: true, revision: 1 });
  });

  it("lists sessions from Band's log when the agent can't list them", async () => {
    const server = await boot({ caps: { list: false } });
    const chatId = newChatId();
    await runTurn(server.url, chatId, "remember me");
    const listed = await trpc<{ supported: boolean; sessions: { summary: string }[] }>(
      server.url,
      "sessions.list",
      { workspaceId: "testproject-main", chatId },
      "query",
    );
    expect(listed.supported).toBe(true);
    expect(listed.sessions.map((s) => s.summary)).toEqual(["remember me"]);
    expect(stubRequests(server.home, "session/list")).toHaveLength(0);
  });
});
