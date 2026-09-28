/**
 * Integration tests for the older-page endpoint backing chat scroll-back
 * pagination (issues #572, #648):
 *
 *   GET /api/chats/:chatId/history?before=<eventId>&revision=<n>
 *
 * Black-box: the real production server boots in a child process with the
 * stub ACP agent (`startAcpServer`). A long session is built by sending
 * TURNS messages through the real submit path (queued behind each other),
 * so Band's chat event log holds TURNS turns. No mocks.
 *
 * What this guards:
 *   • The cold subscribe replays only the last HISTORY_PAGE_SIZE turns and
 *     reports `{ hasOlder, oldestEventId }` in `history-meta`.
 *   • Paging back — each page is the HISTORY_PAGE_SIZE turns before the
 *     cursor, only events older than it, and the page that reaches the
 *     start reports `hasOlder: false`. All pages together are the whole
 *     conversation, in order, once.
 *   • The `before <= 0` guard and a stale `revision` return an empty page.
 *   • A chat with no session, or an unknown chat, returns an empty page.
 *   • Auth — the route is behind the token gate (401 without a cookie).
 *   • Security — the session is resolved SERVER-SIDE from the chat row, so a
 *     client-supplied `sessionId` cannot read another chat's log.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChatEvent, HISTORY_PAGE_SIZE } from "../src/shared/chat-events";
import {
  collectEvents,
  sendMessage,
  startAcpServer,
  TEST_TOKEN,
  trpc,
  WORKSPACE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";
import { listTasksForWorkspace } from "./helpers/tasks";
import { waitFor } from "./helpers/wait-for";

const CHAT_ID = "hist-chat-id";
// 45 turns = two full pages of 20 plus a partial one of 5.
const TURNS = 45;
const prompts = Array.from({ length: TURNS }, (_, i) => `turn ${i + 1}`);

let server: ServerHandle;
let cold: ChatEvent[];

beforeAll(async () => {
  server = await startAcpServer({ turns: [{ steps: [{ say: "ok {{prompt}}" }] }] });
  // The first message starts a turn; the rest queue behind it and run one
  // after another.
  for (const text of prompts) await sendMessage(server.url, CHAT_ID, text);
  await waitFor(
    async () => {
      const tasks = await listTasksForWorkspace(server.url, WORKSPACE_ID, TEST_TOKEN);
      return tasks.filter((t) => t.status === "completed").length === TURNS;
    },
    { timeoutMs: 60_000, intervalMs: 200, label: `${TURNS} turns completed` },
  );
  cold = await collectEvents(server.url, CHAT_ID, { until: (e) => e.type === "history-meta" });
}, 90_000);

afterAll(async () => {
  if (server) await server.close();
});

interface HistoryResponse {
  events: ChatEvent[];
  hasOlder: boolean;
  oldestEventId: number;
}

function getHistory(
  chatId: string,
  params: Record<string, string | number>,
  token: string | null = TEST_TOKEN,
): Promise<Response> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `band_token=${token}`;
  return fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/history?${qs}`, { headers });
}

async function page(params: Record<string, string | number>): Promise<HistoryResponse> {
  const res = await getHistory(CHAT_ID, params);
  expect(res.status).toBe(200);
  return (await res.json()) as HistoryResponse;
}

/** The prompt texts in a list of events. */
function promptsOf(events: ChatEvent[]): string[] {
  return events.flatMap((e) => (e.type === "prompt" ? [e.text] : []));
}

function historyMeta(events: ChatEvent[]) {
  const meta = events.find((e) => e.type === "history-meta");
  if (meta?.type !== "history-meta") throw new Error("no history-meta event");
  return meta;
}

function revisionOf(events: ChatEvent[]): number {
  const opened = events.find((e) => e.type === "subscription-opened");
  if (opened?.type !== "subscription-opened") throw new Error("no subscription-opened event");
  return opened.revision;
}

describe("cold subscribe window", () => {
  it("replays only the last page of turns and reports older ones", () => {
    expect(promptsOf(cold)).toEqual(prompts.slice(TURNS - HISTORY_PAGE_SIZE));
    const logged = cold.filter((e) => e.eventId > 0);
    expect(historyMeta(cold)).toMatchObject({
      hasOlder: true,
      oldestEventId: logged[0].eventId,
    });
    // The window starts at a turn's prompt.
    expect(logged[0]).toMatchObject({
      type: "prompt",
      text: `turn ${TURNS - HISTORY_PAGE_SIZE + 1}`,
    });
  });
});

describe("GET /api/chats/:chatId/history", () => {
  it("pages back turn by turn until the start of the conversation", async () => {
    const revision = revisionOf(cold);
    const first = await page({ before: historyMeta(cold).oldestEventId, revision });
    expect(promptsOf(first.events)).toEqual(
      prompts.slice(TURNS - 2 * HISTORY_PAGE_SIZE, TURNS - HISTORY_PAGE_SIZE),
    );
    expect(first.hasOlder).toBe(true);
    expect(first.oldestEventId).toBe(first.events[0].eventId);
    expect(first.events.every((e) => e.eventId < historyMeta(cold).oldestEventId)).toBe(true);

    const second = await page({ before: first.oldestEventId, revision });
    // The last page reaches the start, including the session attach that
    // came before the first prompt.
    expect(promptsOf(second.events)).toEqual(prompts.slice(0, TURNS - 2 * HISTORY_PAGE_SIZE));
    expect(second.events[0]).toMatchObject({ type: "session-attached", how: "new" });
    expect(second.hasOlder).toBe(false);
    expect(second.events.every((e) => e.eventId < first.oldestEventId)).toBe(true);

    // Every turn exactly once, in order, across the three windows.
    expect([...promptsOf(second.events), ...promptsOf(first.events), ...promptsOf(cold)]).toEqual(
      prompts,
    );
  });

  it("returns an empty page (not an error) when before <= 0", async () => {
    expect(await page({ before: 0 })).toEqual({ events: [], hasOlder: false, oldestEventId: 0 });
    expect(await page({ before: -5 })).toEqual({ events: [], hasOlder: false, oldestEventId: 0 });
  });

  it("returns an empty page for a stale revision", async () => {
    const body = await page({
      before: historyMeta(cold).oldestEventId,
      revision: revisionOf(cold) + 1,
    });
    expect(body).toEqual({ events: [], hasOlder: false, oldestEventId: 0 });
  });

  it("returns an empty page for a chat with no session", async () => {
    await trpc(server.url, "chats.create", { workspaceId: WORKSPACE_ID, id: "hist-empty-chat" });
    const res = await getHistory("hist-empty-chat", { before: 1000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], hasOlder: false, oldestEventId: 0 });
  });

  it("returns an empty page (not a 5xx) for an unknown chatId", async () => {
    const res = await getHistory("no-such-chat", { before: 1000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], hasOlder: false, oldestEventId: 0 });
  });

  it("ignores a client-supplied sessionId: the session comes from the chat row", async () => {
    const { chat } = await trpc<{ chat: { activeSessionId?: string } }>(
      server.url,
      "chats.get",
      { chatId: CHAT_ID },
      "query",
    );
    expect(chat.activeSessionId).toBeTruthy();
    const res = await getHistory("hist-empty-chat", {
      before: 1_000_000,
      sessionId: chat.activeSessionId ?? "",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], hasOlder: false, oldestEventId: 0 });
  });

  it("rejects an oversized chatId with 400", async () => {
    const res = await getHistory("x".repeat(201), { before: 1000 });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await getHistory(CHAT_ID, { before: 1000 }, null);
    expect(res.status).toBe(401);
  });
});
