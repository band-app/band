/**
 * The chat row's persisted `activeSessionSummary` (issues #344, #648).
 *
 * The title the chat pane shows for its session is cached on the chat row,
 * so `chats.get` is a SQLite read. Under ACP it comes from:
 *
 *   • the first prompt of the session, set when the first turn starts;
 *   • the agent's own title, when it sends a `session_info_update`;
 *   • `chats.setActiveSession`: the caller's summary (from the agent's
 *     session list), else the session's first prompt in Band's log.
 *
 * Also pinned: a chat with no active session is never given one on read
 * (issue #478: the "New session" UX clears it and it must stay cleared).
 *
 * Real server bundle, stub ACP agent (`startAcpServer`), tRPC over HTTP.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  collectEvents,
  type StubTurn,
  seedAcpHome,
  sendMessage,
  startAcpServer,
  trpc,
  turnEnded,
  WORKSPACE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

interface ChatRow {
  id: string;
  activeSessionId?: string | null;
  activeSessionSummary?: string | null;
  activeSessionLastModified?: number | null;
}

let servers: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function boot(opts: { home?: string; turns?: StubTurn[] } = {}): Promise<ServerHandle> {
  const server = await startAcpServer(opts);
  servers.push(server);
  return server;
}

let seq = 0;
const newChatId = () => `summary-chat-${Date.now()}-${seq++}`;

async function getChat(url: string, chatId: string): Promise<ChatRow | null> {
  return (await trpc<{ chat: ChatRow | null }>(url, "chats.get", { chatId }, "query")).chat;
}

/** Sends `text` and waits for its turn to end. Returns the turn's events. */
async function runTurn(url: string, chatId: string, text: string, lastEventId?: number) {
  const done = collectEvents(url, chatId, {
    lastEventId,
    until: (e) => turnEnded(e) && e.eventId > (lastEventId ?? 0),
  });
  await new Promise((r) => setTimeout(r, 50));
  await sendMessage(url, chatId, text);
  return done;
}

const maxId = (events: { eventId: number }[]) => Math.max(0, ...events.map((e) => e.eventId));

describe("chats.get — persisted activeSessionSummary", () => {
  it("is the session's first prompt, and later turns don't change it", async () => {
    const server = await boot();
    const chatId = newChatId();

    const first = await runTurn(server.url, chatId, "fix the login bug");
    const attached = first.find((e) => e.type === "session-attached");
    const sessionId = attached?.type === "session-attached" ? attached.sessionId : "";
    let chat = await getChat(server.url, chatId);
    // The chat row carries the agent's own session id.
    expect(chat?.activeSessionId).toBe(sessionId);
    expect(chat?.activeSessionSummary).toBe("fix the login bug");
    expect(typeof chat?.activeSessionLastModified).toBe("number");

    await runTurn(server.url, chatId, "now add a test", maxId(first));
    chat = await getChat(server.url, chatId);
    expect(chat?.activeSessionId).toBe(sessionId);
    expect(chat?.activeSessionSummary).toBe("fix the login bug");
  });

  it("follows the title the agent gives the session (session_info_update)", async () => {
    const server = await boot({
      turns: [
        {
          steps: [
            { say: "On it." },
            { update: { sessionUpdate: "session_info_update", title: "Login fix" } },
          ],
        },
      ],
    });
    const chatId = newChatId();
    await runTurn(server.url, chatId, "fix the login bug");

    const chat = await getChat(server.url, chatId);
    expect(chat?.activeSessionSummary).toBe("Login fix");
    const { state } = await trpc<{ state: { title: string | null } }>(
      server.url,
      "chats.sessionState",
      { chatId },
      "query",
    );
    expect(state.title).toBe("Login fix");
  });

  it("survives a server restart (read from SQLite)", async () => {
    const home = seedAcpHome();
    const first = await boot({ home });
    const chatId = newChatId();
    await runTurn(first.url, chatId, "remember this title");
    await first.close();
    servers = servers.filter((s) => s !== first);

    const second = await boot({ home });
    const chat = await getChat(second.url, chatId);
    expect(chat?.activeSessionSummary).toBe("remember this title");
  });

  it("setActiveSession persists the caller's summary, else the session's first prompt", async () => {
    const server = await boot();
    const source = newChatId();
    const turn = await runTurn(server.url, source, "explore the codebase");
    const attached = turn.find((e) => e.type === "session-attached");
    const sessionId = attached?.type === "session-attached" ? attached.sessionId : "";

    // No summary given: Band's log has the session, so its first prompt.
    const fromLog = newChatId();
    await trpc(server.url, "chats.setActiveSession", {
      workspaceId: WORKSPACE_ID,
      chatId: fromLog,
      sessionId,
    });
    expect(await getChat(server.url, fromLog)).toMatchObject({
      activeSessionId: sessionId,
      activeSessionSummary: "explore the codebase",
    });

    // A summary given (from the agent's session list) wins.
    const fromCaller = newChatId();
    await trpc(server.url, "chats.setActiveSession", {
      workspaceId: WORKSPACE_ID,
      chatId: fromCaller,
      sessionId,
      summary: "Codebase tour",
    });
    expect(await getChat(server.url, fromCaller)).toMatchObject({
      activeSessionId: sessionId,
      activeSessionSummary: "Codebase tour",
    });
  });

  it("setActiveSession to a session Band has no log for leaves the summary empty", async () => {
    const server = await boot();
    const chatId = newChatId();
    await trpc(server.url, "chats.setActiveSession", {
      workspaceId: WORKSPACE_ID,
      chatId,
      sessionId: "session-from-elsewhere",
    });
    const chat = await getChat(server.url, chatId);
    expect(chat?.activeSessionId).toBe("session-from-elsewhere");
    expect(chat?.activeSessionSummary == null).toBe(true);
  });

  it("chats.get on a row with no activeSessionId leaves it null (no auto-promotion)", async () => {
    const server = await boot();
    // Another chat in the workspace has a session Band could promote.
    await runTurn(server.url, newChatId(), "some earlier work");

    const chatId = newChatId();
    await trpc(server.url, "chats.create", { workspaceId: WORKSPACE_ID, id: chatId });
    const first = await getChat(server.url, chatId);
    expect(first?.activeSessionId == null).toBe(true);
    expect(first?.activeSessionSummary == null).toBe(true);
    const second = await getChat(server.url, chatId);
    expect(second?.activeSessionId == null).toBe(true);
    expect(second?.activeSessionSummary == null).toBe(true);
  });

  it("setActiveSession with sessionId=undefined clears both id and summary and stays cleared", async () => {
    const server = await boot();
    const chatId = newChatId();
    await runTurn(server.url, chatId, "explore the codebase");
    expect((await getChat(server.url, chatId))?.activeSessionSummary).toBe("explore the codebase");

    await trpc(server.url, "chats.setActiveSession", { workspaceId: WORKSPACE_ID, chatId });
    const after = await getChat(server.url, chatId);
    expect(after?.activeSessionId == null).toBe(true);
    expect(after?.activeSessionSummary == null).toBe(true);
    // A second read (which fills in missing titles) must not resurrect it.
    const later = await getChat(server.url, chatId);
    expect(later?.activeSessionId == null).toBe(true);
    expect(later?.activeSessionSummary == null).toBe(true);
  });

  it("rejects chats.get without the band_token cookie (401)", async () => {
    const server = await boot();
    const res = await fetch(
      `${server.url}/trpc/chats.get?input=${encodeURIComponent(JSON.stringify({ chatId: "x" }))}`,
    );
    expect(res.status).toBe(401);
  });
});
