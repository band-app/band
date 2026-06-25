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
 *   GET /api/chats/:chatId/history?before=<oldestOffset>&limit=<N>
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
 *
 * Security: the session and workspace are resolved SERVER-SIDE from the chat
 * (mirroring `handleChatEvents`) — never from a client-supplied param. A
 * client `sessionId` is interpolated into a filesystem path by the agent
 * adapter (`.../projects/<dir>/<sessionId>.jsonl`), so trusting it would open a
 * path-traversal read (a `../` value escapes the sessions dir). The chat row is
 * the single source of truth for which session this chat may page.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { jsonlMessageToEvents } from "../server/services/_utils/jsonl-message-to-events";
import { agentService } from "../server/services/agent-service";
import { chatService } from "../server/services/chat-service";
import { taskService } from "../server/services/task-service";
import { workspaceService } from "../server/services/workspace-service";
import { type ChatEvent, HISTORY_PAGE_SIZE } from "../shared/chat-events";

const log = createLogger("chat-history");

/** Default page size when the client omits `limit` — the shared window size. */
const DEFAULT_PAGE_LIMIT = HISTORY_PAGE_SIZE;

/** Hard cap on a client-supplied `limit`. Without it a caller could request
 *  `?limit=1000000` and force the server to read, translate, and JSON-stringify
 *  the entire transcript into one synchronous response buffer. */
const MAX_PAGE_LIMIT = 200;

/** Defensive bound on the route param. `chatId` is only ever a generated slug
 *  (and the route regex already excludes `/`), so anything longer is malformed
 *  input we reject at the boundary rather than pass to the service layer. */
const MAX_CHAT_ID_LENGTH = 200;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // The response page is bounded by MAX_PAGE_LIMIT (200 messages), so this
  // synchronous JSON.stringify stays well under ~1 MB. Raising MAX_PAGE_LIMIT
  // beyond ~500 would warrant streaming the array incrementally instead.
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

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");

  const before = beforeRaw != null ? Number.parseInt(beforeRaw, 10) : NaN;
  // `before <= 0` means there's nothing older to fetch; the upper bound rejects
  // absurd cursors so a bogus value never reaches the adapter as an `offset`
  // (no real session approaches a billion messages).
  if (!Number.isFinite(before) || before <= 0 || before > 1_000_000_000) {
    sendJson(res, 200, { events: [], hasOlder: false, oldestOffset: 0 });
    return;
  }

  const parsedLimit = limitRaw != null ? Number.parseInt(limitRaw, 10) : NaN;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;

  const offset = Math.max(0, before - limit);
  const pageLimit = before - offset;

  // Resolve session + workspace from the chat — NOT from client params. Mirrors
  // `handleChatEvents`: a running task's session wins, else the chat's persisted
  // `activeSessionId`. This is what makes /history page only the session the
  // chat is bound to (see the security note above).
  const chat = chatService.get(chatId);
  const task = taskService.getTask(chatId);
  const sessionId = task?.status === "running" ? task.sessionId : chat?.activeSessionId;
  const workspaceId = chat?.workspaceId;
  if (!sessionId || !workspaceId) {
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
    // Log only the message — the full error embeds internal filesystem paths
    // (e.g. the JSONL path in an ENOENT), which don't belong in logs alongside
    // the session id.
    log.warn(
      { chatId: chatId.slice(0, 8), err: err instanceof Error ? err.message : String(err) },
      "chat-history: failed to read older page",
    );
    sendJson(res, 500, { error: "Internal server error" });
  }
}
