import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { getOrCreateAgent } from "../lib/agent-pool";
import type {
  ChatEvent,
  ChatEventPayload,
  ChatEventUsage,
  ToolInputAvailableEvent,
} from "../lib/chat-events";
import { getChat } from "../lib/chat-manager";
import {
  getQueuedMessages,
  subscribeQueue,
  toWireQueuedMessages,
} from "../lib/queued-message-store";
import { getSessionEventsAfter } from "../lib/session-store";
import { openSseStream, type SseWriter } from "../lib/sse-writer";
import {
  getSessionBuffer,
  getSessionUsage,
  getTask,
  type StreamChunk,
  subscribe as subscribeTask,
} from "../lib/task-runner";
import { resolveWorkspace } from "../lib/workspace";

const log = createLogger("chat-events");

/**
 * Unified chat event log endpoint.
 *
 * `GET /api/chats/:chatId/events`
 *
 * Single subscription replacing the legacy
 * `loadMessages → connectToRunningStream → reconnectToStream` dance on the
 * client. Behaviour:
 *
 *   1. **Subscription open.** Emit a `subscription-opened` event with current
 *      session id + task-running flag. The client uses this as the "first
 *      paint" signal — indicator can show immediately even before a single
 *      content event has arrived.
 *
 *   2. **Replay.** Translate buffered events past `Last-Event-ID` into
 *      `ChatEvent` payloads and emit them. If the buffer doesn't cover the
 *      requested range and the session has JSONL on disk, page in JSONL
 *      with synthetic event ids that sort before the buffer's first event.
 *
 *   3. **Live tail.** Subscribe to `task-runner` broadcasts + queued-message
 *      updates; translate each to `ChatEvent` and emit live.
 *
 *   4. **Close.** When the task transitions to completed/error AND the
 *      queue is empty, close the stream so the client can release the
 *      connection. The client re-opens on next interaction.
 *
 * Differences from the legacy `task-stream.ts` GET handler:
 *
 *   - No 204 path. Even idle chats return 200 with an empty replay + a
 *     `subscription-opened` event.
 *   - Native SSE `id:` framing for `Last-Event-ID`, not embedded payload.
 *   - One closed `ChatEvent` schema, no `INTERNAL_CHUNK_TYPES` filtering.
 *   - Queue mutations are part of the stream (`queue-updated` events).
 */
export async function handleChatEvents(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  // EventSource sends Last-Event-ID as an HTTP header on reconnect. Fall
  // back to a query param so test harnesses + curl can simulate easily.
  //
  // The distinction between `undefined` (no cursor at all) and `0` (client
  // has a cursor but it's at the boundary) matters: cold subscribe with
  // no cursor → full JSONL replay; reconnect with cursor=0 → trust the
  // client has already seen JSONL and skip the replay. Without that the
  // client re-renders the entire conversation on every workspace switch.
  const lastEventIdHeader = req.headers["last-event-id"];
  const lastEventIdParam = url.searchParams.get("lastEventId");
  const parsedHeader =
    lastEventIdHeader != null ? Number.parseInt(String(lastEventIdHeader), 10) : NaN;
  const parsedParam = lastEventIdParam != null ? Number.parseInt(lastEventIdParam, 10) : NaN;
  const lastEventId: number | undefined = Number.isFinite(parsedHeader)
    ? parsedHeader
    : Number.isFinite(parsedParam)
      ? parsedParam
      : undefined;

  // Workspace id can be passed as a query param for the JSONL backfill
  // case (cold subscribe to a chat that has no active task yet).
  const explicitWorkspaceId = url.searchParams.get("workspaceId") ?? undefined;

  // Validate chat exists.
  const chat = getChat(chatId);
  // We tolerate missing chats — they're created lazily on first message.

  // Open the SSE stream. After this point every error must go on the stream
  // (we've already sent headers).
  const writer = openSseStream(res);

  // Counter local to *this subscription* — only used for events the server
  // synthesises (subscription-opened, queue-updated, JSONL backfill). Real
  // task events keep their `task-runner`-assigned buffer eventIds.
  // Synthetic ids are negative so they sort before any real buffer ids.
  let nextSyntheticId = -1;

  const task = getTask(chatId);
  // Resolve the session to replay from:
  //   1. The in-memory task's sessionId — ONLY when the task is currently
  //      running. For a *completed* task that hasn't been evicted from
  //      the `tasks` map, the session it ran against may differ from
  //      the chat row's current `activeSessionId` (e.g. the user just
  //      clicked "Select past session" or "New session"). In that case
  //      `chat.activeSessionId` is the fresher signal.
  //   2. Else the chat row's persisted `activeSessionId`. Covers
  //      reopening a workspace whose previous task has completed AND
  //      covers the session-switch case above.
  // Without (2), the server replays nothing for a "cold" chat that has
  // history on disk, and the client sits on the skeleton forever because
  // `messages.length === 0` AND `initialSessionId` is set. See issue #478.
  const resolvedSessionId = task?.status === "running" ? task.sessionId : chat?.activeSessionId;

  // Initial subscription-opened event.
  emit(writer, {
    type: "subscription-opened",
    sessionId: resolvedSessionId,
    taskRunning: task?.status === "running",
    eventId: nextSyntheticId--,
  });

  // Initial queue snapshot — ALWAYS emit, even when empty. A client that
  // disconnected (workspace switch, tab hidden, network blip) with a
  // non-empty reducer queue would otherwise keep displaying those stale
  // entries when the subscription reopens: every drain happened while the
  // EventSource was closed, so the reducer never saw the `queue-updated`
  // events that cleared them. The server is authoritative; resync on
  // every subscribe regardless of whether the queue is empty or not.
  emit(writer, {
    type: "queue-updated",
    messages: toWireQueuedMessages(getQueuedMessages(chatId)),
    eventId: nextSyntheticId--,
  });

  // Initial usage snapshot, if any.
  if (resolvedSessionId) {
    const usage = getSessionUsage(resolvedSessionId);
    if (usage) {
      emit(writer, { type: "usage", data: usage, eventId: nextSyntheticId-- });
    }
  }

  // Register the live-tail subscribers BEFORE replayPast so that
  // task-runner broadcasts arriving during replay (the most important
  // case: a fast agent crash that fires `task-error` while we're still
  // reading JSONL) land in our queue instead of being dropped because no
  // listener was registered. We dedup against `lastEmittedId` (running
  // max), updated inside the writer wrapper, so events that replayPast
  // also emitted aren't double-sent.
  const queue: ChatEvent[] = [];
  let notify: (() => void) | null = null;
  let lastEmittedId = lastEventId ?? Number.NEGATIVE_INFINITY;

  const trackedWriter: SseWriter = {
    get closed() {
      return writer.closed;
    },
    write(evt) {
      writer.write(evt);
      if (evt.eventId > lastEmittedId) lastEmittedId = evt.eventId;
    },
    comment(text) {
      writer.comment(text);
    },
    close() {
      writer.close();
    },
  };

  const unsubscribeTask = subscribeTask(chatId, (chunk: StreamChunk) => {
    const eid = chunk.eventId;
    if (eid != null && eid <= lastEmittedId) {
      return; // already replayed/emitted
    }
    const payload = chunkToChatEvent(chunk, resolvedSessionId);
    if (!payload) return;
    queue.push({ ...payload, eventId: eid ?? nextSyntheticId-- } as ChatEvent);
    notify?.();
  });

  const unsubscribeQueue = subscribeQueue((qChatId, messages) => {
    if (qChatId !== chatId) return;
    queue.push({
      type: "queue-updated",
      messages: toWireQueuedMessages(messages),
      eventId: nextSyntheticId--,
    });
    notify?.();
  });

  const onClose = () => {
    notify?.();
  };
  res.on("close", onClose);

  // Replay phase. `afterEventId === undefined` triggers a cold subscribe
  // (full JSONL replay). Any provided value — including 0 — is treated as
  // a hot reconnect: the client tells us "I already have history up to N,
  // just give me events past N". The previous `lastEventId > 0` check
  // mapped 0 → undefined and forced JSONL re-replay on every reconnect
  // for sessions that never produced a live buffer event.
  await replayPast({
    writer: trackedWriter,
    chatId,
    sessionId: resolvedSessionId,
    afterEventId: lastEventId,
    chatWorkspaceId: chat?.workspaceId ?? explicitWorkspaceId,
    agentTypeHint: chat?.agent,
  }).catch((err) => {
    log.warn({ chatId, err }, "replay phase failed; continuing to live tail");
  });

  // If no task is running and the queue is empty, we still keep the stream
  // open — the client expects the subscription to survive idle periods so
  // it can pick up the next user submission's events live. Close on
  // request abort.

  try {
    while (!res.destroyed && !writer.closed) {
      while (queue.length > 0) {
        const evt = queue.shift()!;
        // Final dedup safety net: replayPast may have emitted this event
        // after the subscribe handler's check but before we got here.
        // The `eventId >= 0` guard intentionally skips dedup for synthetic
        // negative-id events. The invariant that makes this safe: negative
        // ids are only ever assigned by THIS file (here via `nextSyntheticId--`
        // and inside replayPast for the cold JSONL path). They are never
        // re-emitted by the live subscriber and never collide between
        // replay+live because the subscriber's pre-existing `nextSyntheticId`
        // closure keeps decrementing past whatever replay used. Without the
        // guard a freshly-pushed `queue-updated` with eventId=-3 would be
        // dropped just because lastEmittedId is at e.g. 12 from real events.
        if (evt.eventId <= lastEmittedId && evt.eventId >= 0) continue;
        emit(trackedWriter, evt);

        // Close the stream once the active task settles and there are no
        // queued messages to drain. The client reopens on its next user
        // interaction (or visibility change).
        if (evt.type === "task-completed" || evt.type === "task-error") {
          const hasQueued = getQueuedMessages(chatId).length > 0;
          const stillRunning = getTask(chatId)?.status === "running";
          if (!hasQueued && !stillRunning) {
            return;
          }
        }
      }
      await new Promise<void>((r) => {
        notify = r;
      });
      notify = null;
    }
  } finally {
    unsubscribeTask();
    unsubscribeQueue();
    res.off("close", onClose);
    writer.close();
  }
}

function emit(writer: SseWriter, event: ChatEvent | (ChatEventPayload & { eventId: number })) {
  writer.write(event as ChatEvent);
}

/**
 * Replay buffered events from after `afterEventId`, optionally backfilling
 * from JSONL when the buffer doesn't cover the range. Emits events directly
 * to the writer.
 */
async function replayPast(opts: {
  writer: SseWriter;
  chatId: string;
  sessionId: string | undefined;
  afterEventId: number | undefined;
  chatWorkspaceId: string | undefined;
  agentTypeHint: string | undefined;
}): Promise<void> {
  const { writer, chatId, sessionId, afterEventId, chatWorkspaceId, agentTypeHint } = opts;
  if (!sessionId) {
    // No session yet — nothing to replay. Backfilling from JSONL requires
    // the agent + workspace; without sessionId we don't know which
    // session's transcript to read.
    return;
  }

  const buf = getSessionBuffer(sessionId);

  // Two distinct replay paths:
  //
  //   • Hot reconnect (`afterEventId` set) — gap-fill from the in-memory
  //     buffer. The client already saw everything up to the cursor; we
  //     only need to send what came after. JSONL fallback handles the
  //     rare case where the buffer has rotated past the cursor.
  //
  //   • Cold subscribe (`afterEventId` undefined) — replay the FULL
  //     session history. JSONL is authoritative here: the agent flushes
  //     every turn's user-message, tool calls and assistant text to it
  //     incrementally, so it covers prior turns the in-memory buffer
  //     may have lost (server restarts, session-switch, …). The buffer
  //     overlaps with JSONL on the latest turn, so when JSONL has any
  //     content we trust it as the source of truth and skip the buffer
  //     replay to avoid duplicating events. Without this split, picking
  //     a session from history and submitting a message ended up with
  //     only the last turn visible after a page refresh — the buffer
  //     had the new turn and the older JSONL history was elided.
  if (afterEventId === undefined) {
    // Cold subscribe — JSONL is the full history.
    let jsonlEmittedAny = false;
    if (chatWorkspaceId) {
      try {
        const workspace = resolveWorkspace(chatWorkspaceId);
        if (workspace) {
          const agent = await getOrCreateAgent(chatId, workspace.worktree.path, agentTypeHint);
          if (agent.supportedFeatures.sessionListing && agent.getSessionMessages) {
            const result = await agent.getSessionMessages(sessionId, workspace.worktree.path, {});
            const messages = result.messages;
            // Synthetic ids sort below any live buffer ids (-1000-N..-1000),
            // so subsequent live events the client receives keep their
            // monotonic order.
            let syntheticId = -1000 - messages.length;
            for (const msg of messages) {
              const events = jsonlMessageToEvents(msg, syntheticId);
              for (const evt of events) {
                writer.write(evt);
                jsonlEmittedAny = true;
              }
              syntheticId += Math.max(events.length, 1);
            }
          }
        }
      } catch (err) {
        log.warn({ chatId, sessionId, err }, "JSONL backfill failed; falling through to buffer");
      }
    }
    // Buffer fallback — only when JSONL was unusable (agent doesn't
    // support session listing, workspace unresolvable, or read failed).
    // Otherwise the buffer overlaps with what we just emitted.
    if (!jsonlEmittedAny && buf) {
      for (const c of buf.events) {
        const payload = chunkToChatEvent(c as StreamChunk, sessionId);
        if (!payload) continue;
        writer.write({ ...payload, eventId: c.eventId ?? 0 } as ChatEvent);
      }
    }
    return;
  }

  // Hot reconnect path — gap-fill from buffer past the cursor. JSONL is
  // only re-fetched when the buffer DOESN'T cover the cursor:
  //
  //   • `buf === undefined` — the in-memory buffer is GONE (server
  //     restart, eviction). The client carries a cursor from before the
  //     restart; without JSONL it would see a blank chat until the next
  //     agent turn produces fresh events. Treat as a gap, backfill.
  //   • `buf.events.length === 0` — buffer exists but has no events
  //     since the cursor. Client is fully caught up; no JSONL needed.
  //     (Avoids re-pushing the conversation on every workspace switch
  //     / visibility toggle.)
  //   • `buf.events.length > 0 && cursor + 1 < buf.events[0].eventId` —
  //     buffer rotated past the cursor (MAX_BUFFER_SIZE eviction).
  //     Backfill the missing range from JSONL.
  const bufferFirstId =
    buf && buf.events.length > 0 ? (buf.events[0].eventId ?? 0) : Number.POSITIVE_INFINITY;
  const needJsonl = !buf || (buf.events.length > 0 && afterEventId + 1 < bufferFirstId);

  if (needJsonl && chatWorkspaceId) {
    try {
      const workspace = resolveWorkspace(chatWorkspaceId);
      if (workspace) {
        const agent = await getOrCreateAgent(chatId, workspace.worktree.path, agentTypeHint);
        if (agent.supportedFeatures.sessionListing && agent.getSessionMessages) {
          const result = await agent.getSessionMessages(sessionId, workspace.worktree.path, {});
          const messages = result.messages;
          // Synthetic ids must sit strictly in the gap `(afterEventId,
          // bufferFirstId)` so they (a) survive the `<= afterEventId` filter
          // below and (b) sort before live buffer ids. The naive
          // `bufferFirstId - messages.length` start fails for sessions whose
          // JSONL length exceeds the gap: every id ends up ≤ afterEventId
          // and the whole backfill gets silently dropped. Picking
          // `afterEventId + 1` as the lower bound guarantees no event is
          // skipped by the filter even when `messages.length` is large.
          // (Hot-reconnect doesn't usually backfill a huge transcript —
          // JSONL is only fetched when the in-memory buffer has rotated
          // past the cursor — so we don't worry about the per-event step
          // crossing into bufferFirstId; the client-side dedup catches the
          // rare overlap.)
          let syntheticId =
            bufferFirstId === Number.POSITIVE_INFINITY
              ? afterEventId + 1
              : Math.max(afterEventId + 1, bufferFirstId - messages.length);
          for (const msg of messages) {
            const events = jsonlMessageToEvents(msg, syntheticId);
            for (const evt of events) {
              if (evt.eventId <= afterEventId) continue;
              writer.write(evt);
            }
            syntheticId += Math.max(events.length, 1);
          }
        }
      }
    } catch (err) {
      log.warn({ chatId, sessionId, err }, "JSONL backfill failed; falling through to buffer");
    }
  }

  if (buf) {
    // Intentional: we replay EVERY buffer event past the cursor regardless
    // of which task produced it. Auto-queued sends reuse `sessionId`
    // (see `task-runner.ts::submitTask` after `shiftQueuedMessage`), so the
    // buffer can hold events from multiple sequential tasks under one
    // session. A client reconnecting mid-session with a stale cursor needs
    // those prior-task tail events to reconstruct its state — they are NOT
    // duplicates from its perspective, just events it hasn't seen yet.
    //
    // The old `task-stream.ts` Phase-2b filtered to `eventId >= task.firstEventId`,
    // which was correct under a "one task per stream" model but wrong here:
    // a client with cursor=N reconnecting after task A finished and task B
    // started would have lost A's last events. Client-side dedup
    // (`event.eventId <= state.lastEventId → skip`) is the right place for
    // ordering safety; the server simply ships everything past the cursor.
    const events = getSessionEventsAfter(sessionId, afterEventId);
    for (const row of events) {
      const chunk = row.chunk as StreamChunk;
      const payload = chunkToChatEvent(chunk, sessionId);
      if (!payload) continue;
      writer.write({ ...payload, eventId: row.id ?? chunk.eventId ?? 0 } as ChatEvent);
    }
  }
}

/**
 * Strip the `[File sharing: …]` agent-context hint that `task-runner`
 * appends to the FIRST user prompt of a new session (see `fileSharingHint`
 * in `apps/web/src/lib/task-runner.ts`). The hint is meant for the agent,
 * not the user — and the live `user-message` broadcast already strips it
 * by using `task.prompt` (the clean original) instead of `task.agentPrompt`.
 * On JSONL replay we read whatever the agent persisted, which DOES include
 * the hint suffix — so we strip it here too.
 */
function stripFileSharingHint(text: string): string {
  return text.replace(/\n\n\[File sharing:[\s\S]*?\]\s*$/, "");
}

/**
 * Map a SessionMessageItem (from agent JSONL) to a synthetic ChatEvent
 * sequence. We synthesise the same events the live stream would produce so
 * the reducer doesn't need a special-case path for "this came from JSONL".
 */
function jsonlMessageToEvents(
  msg: {
    role: "user" | "assistant";
    id: string;
    content: Array<
      | { type: "text"; text: string }
      | {
          type: "tool_use";
          toolCallId: string;
          toolName: string;
          displayTitle?: string;
          input: unknown;
        }
      | { type: "tool_result"; toolCallId: string; output: string; isError: boolean }
    >;
  },
  startId: number,
): ChatEvent[] {
  const events: ChatEvent[] = [];
  let id = startId;

  if (msg.role === "user") {
    const textPart = msg.content.find(
      (p): p is { type: "text"; text: string } => p.type === "text",
    );
    events.push({
      type: "user-message",
      text: stripFileSharingHint(textPart?.text ?? ""),
      eventId: id++,
    });
    return events;
  }

  // Assistant message → translate parts into the live-stream event sequence.
  for (const part of msg.content) {
    if (part.type === "text") {
      const textPartId = `${msg.id}-text-${id}`;
      events.push({ type: "text-start", id: textPartId, eventId: id++ });
      events.push({ type: "text-delta", id: textPartId, delta: part.text, eventId: id++ });
      events.push({ type: "text-end", id: textPartId, eventId: id++ });
    } else if (part.type === "tool_use") {
      events.push({
        type: "tool-input-available",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        displayTitle: part.displayTitle,
        input: part.input,
        eventId: id++,
      });
    } else if (part.type === "tool_result") {
      events.push({
        type: "tool-output-available",
        toolCallId: part.toolCallId,
        output: part.output,
        isError: part.isError,
        eventId: id++,
      });
    }
  }
  return events;
}

/**
 * Translate a task-runner broadcast chunk into a ChatEvent payload.
 * Returns `undefined` for chunks that don't surface to the chat-event stream
 * (e.g. `finish`, `finish-step` — replaced by `task-completed`).
 */
function chunkToChatEvent(
  chunk: StreamChunk,
  _sessionId: string | undefined,
): ChatEventPayload | undefined {
  const c = chunk as unknown as Record<string, unknown> & { type: string };
  switch (c.type) {
    case "user-message":
      return {
        type: "user-message",
        text: String(c.text ?? ""),
        files: c.files as ChatEventPayload extends { type: "user-message" }
          ? Extract<ChatEventPayload, { type: "user-message" }>["files"]
          : undefined,
      };

    case "task-started":
      return {
        type: "task-started",
        taskId: String(c.taskId ?? ""),
        agentType: typeof c.agentType === "string" ? c.agentType : undefined,
        model: typeof c.model === "string" ? c.model : undefined,
        mode: typeof c.mode === "string" ? c.mode : undefined,
      };

    case "task-completed":
      return {
        type: "task-completed",
        taskId: String(c.taskId ?? ""),
        durationMs: typeof c.durationMs === "number" ? c.durationMs : undefined,
        numTurns: typeof c.numTurns === "number" ? c.numTurns : undefined,
        costUsd: typeof c.costUsd === "number" ? c.costUsd : undefined,
      };

    case "task-error":
      return {
        type: "task-error",
        taskId: String(c.taskId ?? ""),
        message: String(c.message ?? "Unknown error"),
      };

    case "data-session": {
      const data = c.data as { sessionId?: string } | undefined;
      if (!data?.sessionId) return undefined;
      return { type: "session-resolved", sessionId: data.sessionId };
    }

    case "data-usage": {
      const data = c.data as ChatEventUsage | undefined;
      if (!data) return undefined;
      return { type: "usage", data };
    }

    case "data-result": {
      const data = c.data as
        | { sessionId?: string; durationMs?: number; numTurns?: number; costUsd?: number }
        | undefined;
      if (!data) return undefined;
      return {
        type: "result",
        sessionId: data.sessionId,
        durationMs: data.durationMs,
        numTurns: data.numTurns,
        costUsd: data.costUsd,
      };
    }

    case "text-start":
      return { type: "text-start", id: String(c.id ?? "") };

    case "text-delta":
      return { type: "text-delta", id: String(c.id ?? ""), delta: String(c.delta ?? "") };

    case "text-end":
      return { type: "text-end", id: String(c.id ?? "") };

    case "tool-input-available":
      return {
        type: "tool-input-available",
        toolCallId: String(c.toolCallId ?? ""),
        toolName: String(c.toolName ?? ""),
        input: c.input,
        displayTitle: typeof c.title === "string" ? c.title : undefined,
        approvalId:
          c.approval && typeof (c.approval as { id?: string }).id === "string"
            ? (c.approval as { id: string }).id
            : undefined,
      } satisfies ToolInputAvailableEvent;

    case "tool-output-available":
      return {
        type: "tool-output-available",
        toolCallId: String(c.toolCallId ?? ""),
        output: String(c.output ?? ""),
        isError: c.state === "output-error" || c.isError === true,
      };

    case "error":
      return { type: "error", message: String(c.errorText ?? c.message ?? "Unknown error") };

    case "file":
      // Agent-produced file (image, download, etc.) — either emitted
      // directly by the agent or scanned from the workspace's shared dir
      // after a tool call. The client attaches it as a `file` part on the
      // current assistant message.
      return {
        type: "file",
        mediaType: String(c.mediaType ?? "application/octet-stream"),
        url: String(c.url ?? ""),
        ...(typeof c.filename === "string" ? { filename: c.filename } : {}),
      };

    // `finish` and `finish-step` are AI-SDK protocol terminators — replaced
    // by `task-completed` / `task-error` in the new stream.
    case "finish":
    case "finish-step":
      return undefined;

    default:
      return undefined;
  }
}
