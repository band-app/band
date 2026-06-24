/**
 * GET /api/chats/:chatId/history
 *
 * Older-page fetch for chat scroll-back pagination (issue #572).
 *
 * The cold subscribe (`GET /api/chats/:chatId/events`) replays only the most
 * recent window of a session (`COLD_REPLAY_LIMIT` messages) and emits a
 * `history-meta` event carrying `{ hasOlder, oldestOffset }`. When the user
 * scrolls to the top, the client requests the page immediately PRECEDING the
 * messages it already holds:
 *
 *   GET /api/chats/:chatId/history?sessionId=<id>&workspaceId=<id>&before=<oldestOffset>&limit=<N>
 *
 * `before` is the absolute index (into the agent's filtered message list) of
 * the first message the client currently holds. The handler returns the
 * messages in `[max(0, before - limit), before)` translated into the same
 * `ChatEvent` shapes the live SSE stream and JSONL cold replay emit — so the
 * client folds them through the identical `chatEventReducer` and prepends the
 * result. Response:
 *
 *   { events: ChatEvent[], hasOlder: boolean, oldestOffset: number }
 *
 * `hasOlder` is `offset > 0` (are there messages before this page) and
 * `oldestOffset` is the new cursor for the next-older request. The synthetic
 * event ids on the returned events are internally sequential only — the client
 * folds them in isolation and re-namespaces message ids, so the absolute values
 * never reach the main reducer's cursor.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { jsonlMessageToEvents } from "../server/services/_utils/jsonl-message-to-events";
import { agentService } from "../server/services/agent-service";
import { chatService } from "../server/services/chat-service";
import { workspaceService } from "../server/services/workspace-service";
import type { ChatEvent } from "../shared/chat-events";

const log = createLogger("chat-history");

/** Default page size — kept in sync with `COLD_REPLAY_LIMIT` in chat-events.ts
 *  and the page size the client requests. */
const DEFAULT_PAGE_LIMIT = 50;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleChatHistory(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const explicitWorkspaceId = url.searchParams.get("workspaceId") ?? undefined;
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");

  const before = beforeRaw != null ? Number.parseInt(beforeRaw, 10) : NaN;
  if (!sessionId || !Number.isFinite(before) || before <= 0) {
    // `before <= 0` means there's nothing older to fetch — return an empty page
    // rather than an error so the client's guard stays simple.
    sendJson(res, 200, { events: [], hasOlder: false, oldestOffset: 0 });
    return;
  }

  const parsedLimit = limitRaw != null ? Number.parseInt(limitRaw, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_PAGE_LIMIT;

  const offset = Math.max(0, before - limit);
  const pageLimit = before - offset;

  const chat = chatService.get(chatId);
  const workspaceId = chat?.workspaceId ?? explicitWorkspaceId;
  if (!workspaceId) {
    sendJson(res, 200, { events: [], hasOlder: false, oldestOffset: 0 });
    return;
  }

  try {
    const workspace = workspaceService.resolve(workspaceId);
    if (!workspace) {
      sendJson(res, 200, { events: [], hasOlder: false, oldestOffset: 0 });
      return;
    }
    const agent = await agentService.getOrCreateAgent(chatId, workspace.worktree.path, chat?.agent);
    if (!agent.supportedFeatures.sessionListing || !agent.getSessionMessages) {
      sendJson(res, 200, { events: [], hasOlder: false, oldestOffset: 0 });
      return;
    }

    const result = await agent.getSessionMessages(sessionId, workspace.worktree.path, {
      offset,
      limit: pageLimit,
    });

    // Translate the older messages into the same ChatEvent sequence the live
    // stream / cold replay produce. Ids are sequential from 1; the client folds
    // these through a fresh reducer in isolation, so the values matter only for
    // intra-page ordering.
    const events: ChatEvent[] = [];
    let id = 1;
    for (const msg of result.messages) {
      const msgEvents = jsonlMessageToEvents(msg, id);
      events.push(...msgEvents);
      id += Math.max(msgEvents.length, 1);
    }

    sendJson(res, 200, {
      events,
      // There is older history iff this page didn't start at the very first
      // message. `result.firstOffset` echoes the requested `offset`.
      hasOlder: result.firstOffset > 0,
      oldestOffset: result.firstOffset,
    });
  } catch (err) {
    log.warn({ chatId, sessionId, err }, "chat-history: failed to read older page");
    sendJson(res, 500, { error: "Internal server error" });
  }
}
