import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import {
  getQueuedMessages,
  subscribeQueue,
  toWireQueuedMessages,
} from "../server/services/_utils/queued-message-store";
import { openSseStream, type SseWriter } from "../server/services/_utils/sse-writer";
import { agentSessionService } from "../server/services/agent-session-service";
import { chatService } from "../server/services/chat-service";
import { taskService } from "../server/services/task-service";
import { type ChatEvent, HISTORY_PAGE_SIZE } from "../shared/chat-events";

const log = createLogger("chat-events");

function parseIntOrUndefined(value: string | string[] | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Chat event stream.
 *
 * `GET /api/chats/:chatId/events?lastEventId=<id>&revision=<n>`
 *
 *   1. `subscription-opened` with the chat's session, the log revision the
 *      replay comes from and whether a turn runs. `reset: true` tells a
 *      client that holds a different revision to drop its state, because
 *      the log was rebuilt by `session/load` (issue #648).
 *   2. `queue-updated` and `session-state` snapshots.
 *   3. Replay from Band's event log: everything after the cursor on a
 *      reconnect, the last `HISTORY_PAGE_SIZE` turns on a cold subscribe
 *      (followed by `history-meta`). A session Band has no log for is
 *      loaded from the agent (`session/load`) into the log first, then
 *      replayed through the same window.
 *   4. Live tail until the client disconnects, or a turn ends with nothing
 *      running or queued after it.
 *
 * The cursor comes from the `Last-Event-ID` header (EventSource sets it on
 * its own reconnects) or the `lastEventId` query param. Logged events carry
 * their row id; synthetic ones carry negative ids and never move it.
 */
export async function handleChatEvents(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const cursor =
    parseIntOrUndefined(req.headers["last-event-id"]) ??
    parseIntOrUndefined(url.searchParams.get("lastEventId"));
  const clientRevision = parseIntOrUndefined(url.searchParams.get("revision"));

  const writer = openSseStream(res);
  let syntheticId = -1;

  const chat = chatService.get(chatId);
  const sessionId = chat?.activeSessionId;
  const revision = sessionId ? agentSessionService.logRevision(sessionId) : 0;
  // A client that already holds events of another revision starts over.
  const reset = cursor !== undefined && clientRevision !== undefined && clientRevision !== revision;
  const cold = cursor === undefined || reset;

  writer.write({
    type: "subscription-opened",
    sessionId,
    revision,
    taskRunning: taskService.getTask(chatId)?.status === "running",
    reset,
    eventId: syntheticId--,
  });
  writer.write({
    type: "queue-updated",
    messages: toWireQueuedMessages(getQueuedMessages(chatId)),
    eventId: syntheticId--,
  });

  // Register the live listeners before replaying, so nothing broadcast
  // during the replay is lost. `lastSent` dedups logged events the replay
  // already sent.
  const queue: ChatEvent[] = [];
  let notify: (() => void) | null = null;
  let lastSent = cold ? 0 : (cursor ?? 0);
  const send = (w: SseWriter, event: ChatEvent) => {
    if (event.eventId > 0) {
      if (event.eventId <= lastSent) return;
      lastSent = event.eventId;
    }
    w.write(event);
  };

  const unsubscribeEvents = agentSessionService.subscribe(chatId, (event) => {
    queue.push(event);
    notify?.();
  });
  const unsubscribeQueue = subscribeQueue((qChatId, messages) => {
    if (qChatId !== chatId) return;
    queue.push({
      type: "queue-updated",
      messages: toWireQueuedMessages(messages),
      eventId: syntheticId--,
    });
    notify?.();
  });
  const onClose = () => notify?.();
  res.on("close", onClose);

  try {
    writer.write({
      type: "session-state",
      state: agentSessionService.getSessionState(chatId),
      eventId: syntheticId--,
    });

    const sendWindow = (rev: number) => {
      if (!sessionId || rev === 0) {
        writer.write({
          type: "history-meta",
          hasOlder: false,
          oldestEventId: 0,
          eventId: syntheticId--,
        });
        return;
      }
      const page = agentSessionService.replayTurns(sessionId, rev, HISTORY_PAGE_SIZE);
      for (const event of page.events) send(writer, event);
      writer.write({
        type: "history-meta",
        hasOlder: page.hasOlder,
        oldestEventId: page.oldestEventId,
        eventId: syntheticId--,
      });
    };

    if (sessionId && revision > 0) {
      if (cold) {
        sendWindow(revision);
      } else {
        for (const event of agentSessionService.replayAfter(sessionId, revision, cursor ?? 0)) {
          send(writer, event);
        }
      }
    } else if (cold && sessionId) {
      // Band never recorded this session (it was picked from the agent's
      // history): ask the agent to replay it into the log, then send the
      // same windowed replay as for any logged session. The replay also
      // reached the live listener while it was written; those rows are in
      // the window or in older pages, so drop them from the live queue.
      try {
        await agentSessionService.ensureSession(chatId, "view");
      } catch (err) {
        log.warn({ chatId, sessionId, err }, "could not load session history");
        agentSessionService.broadcastTransient(chatId, {
          type: "notice",
          level: "warning",
          text: `This session's history couldn't be loaded: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].eventId > 0) queue.splice(i, 1);
      }
      const loaded = agentSessionService.logRevision(sessionId);
      if (loaded !== revision) {
        writer.write({
          type: "subscription-opened",
          sessionId,
          revision: loaded,
          taskRunning: taskService.getTask(chatId)?.status === "running",
          reset: false,
          eventId: syntheticId--,
        });
      }
      sendWindow(loaded);
    } else if (cold) {
      sendWindow(0);
    }

    while (!res.destroyed && !writer.closed) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        send(writer, event);
        // A turn ended with nothing queued behind it: close, so a watcher
        // (`band chats watch`) ends with the turn. The browser reopens a
        // closed stream on its own, with its cursor.
        if (
          event.type === "turn-ended" &&
          taskService.getTask(chatId)?.status !== "running" &&
          getQueuedMessages(chatId).length === 0
        ) {
          return;
        }
      }
      await new Promise<void>((r) => {
        notify = r;
      });
      notify = null;
    }
  } catch (err) {
    log.warn({ chatId, err }, "chat event stream failed");
  } finally {
    unsubscribeEvents();
    unsubscribeQueue();
    res.off("close", onClose);
    writer.close();
  }
}
