/**
 * One chat's event stream and history, over the hub's HTTP API. The web hook
 * and the mobile app both feed the events into `transcriptReducer`.
 */

import { CHAT_EVENT_TYPES, type ChatEvent } from "@band-app/shared/chat-events";

import type { HubFetch } from "./hub-client.ts";
import { openSseStream, type SseStream } from "./sse.ts";

export interface ChatCursor {
  lastEventId?: number;
  revision: number;
}

export interface ChatStreamOptions {
  fetch: HubFetch;
  chatId: string;
  /** The reducer's current cursor, read at every (re)connect. */
  getCursor: () => ChatCursor;
  onEvent: (event: ChatEvent) => void;
  onConnection?: (connected: boolean) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const EVENT_TYPES = new Set<string>(CHAT_EVENT_TYPES);

/** Path of the events endpoint, resuming after `cursor.lastEventId` when there is one. */
export function chatEventsPath(chatId: string, cursor: ChatCursor): string {
  const params = new URLSearchParams();
  if (cursor.lastEventId !== undefined) {
    params.set("lastEventId", String(cursor.lastEventId));
    params.set("revision", String(cursor.revision));
  }
  const query = params.toString();
  const path = `/api/chats/${encodeURIComponent(chatId)}/events`;
  return query ? `${path}?${query}` : path;
}

export function openChatStream(options: ChatStreamOptions): SseStream {
  return openSseStream({
    fetch: options.fetch,
    path: () => chatEventsPath(options.chatId, options.getCursor()),
    initialBackoffMs: options.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    onConnection: options.onConnection,
    onFrame: (frame) => {
      if (!EVENT_TYPES.has(frame.event)) return;
      try {
        options.onEvent(JSON.parse(frame.data) as ChatEvent);
      } catch (err) {
        console.error("[chat-stream] bad event", err);
      }
    },
  });
}

export interface ChatHistoryPage {
  events: ChatEvent[];
  hasOlder: boolean;
  oldestEventId: number;
}

/** The turns before `before` (an event id), for scroll-back (issue #572). */
export async function fetchChatHistory(
  fetchHub: HubFetch,
  chatId: string,
  before: number,
  revision: number,
): Promise<ChatHistoryPage> {
  const params = new URLSearchParams({ before: String(before), revision: String(revision) });
  const res = await fetchHub(
    `/api/chats/${encodeURIComponent(chatId)}/history?${params.toString()}`,
  );
  if (!res.ok) throw new Error(`history fetch failed: HTTP ${res.status}`);
  return (await res.json()) as ChatHistoryPage;
}
