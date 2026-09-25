/**
 * GET /api/chats/:chatId/history?before=<eventId>&revision=<n>
 *
 * Older-page fetch for chat scroll-back pagination (issue #572). The cold
 * subscribe (`GET /api/chats/:chatId/events`) replays only the last
 * `HISTORY_PAGE_SIZE` turns and reports the id of the oldest event it sent
 * in `history-meta`. When the user scrolls to the top, the client asks for
 * the turns before that id, read from Band's chat event log (issue #648):
 *
 *   { events: ChatEvent[], hasOlder: boolean, oldestEventId: number }
 *
 * The events are the same shapes the live stream sends, so the client folds
 * them through the same reducer.
 *
 * The session is resolved from the chat row, never from a client param, so
 * a chat can only page its own session. A `revision` that no longer matches
 * the log answers with nothing: the client is about to get a reset from its
 * event stream anyway.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { agentSessionService } from "../server/services/agent-session-service";
import { chatService } from "../server/services/chat-service";
import { HISTORY_PAGE_SIZE } from "../shared/chat-events";

/** Defensive bound on the route param; chat ids are short generated slugs. */
const MAX_CHAT_ID_LENGTH = 200;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleChatHistory(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
): Promise<void> {
  if (!chatId || chatId.length > MAX_CHAT_ID_LENGTH) {
    sendJson(res, 400, { error: "Invalid chatId" });
    return;
  }
  const empty = { events: [], hasOlder: false, oldestEventId: 0 };

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const before = Number.parseInt(url.searchParams.get("before") ?? "", 10);
  if (!Number.isFinite(before) || before <= 0) {
    sendJson(res, 200, empty);
    return;
  }

  const sessionId = chatService.get(chatId)?.activeSessionId;
  if (!sessionId) {
    sendJson(res, 200, empty);
    return;
  }
  const revision = agentSessionService.logRevision(sessionId);
  const clientRevision = Number.parseInt(url.searchParams.get("revision") ?? "", 10);
  if (revision === 0 || (Number.isFinite(clientRevision) && clientRevision !== revision)) {
    sendJson(res, 200, empty);
    return;
  }

  const page = agentSessionService.replayTurns(sessionId, revision, HISTORY_PAGE_SIZE, before);
  sendJson(res, 200, {
    events: page.events,
    hasOlder: page.hasOlder,
    oldestEventId: page.events[0]?.eventId ?? 0,
  });
}
