/**
 * Thin SSE writer for the `/api/chats/:chatId/events` endpoint.
 *
 * Replaces `createUIMessageStream` + `pipeUIMessageStreamToResponse` from
 * the `ai` package on the new code path. The AI-SDK helpers were the right
 * shape when `useChat` was the consumer; under the event-log model the
 * client owns the schema (`ChatEvent`) and reads native SSE `id:` lines
 * via `EventSource`. A 30-line writer is enough — no need for the helper's
 * chunk-schema validation or its zod-strict-object filtering.
 */

import type { ServerResponse } from "node:http";
import type { ChatEvent } from "../../shared/chat-events";

const HEARTBEAT_INTERVAL_MS = 25_000;

export interface SseWriter {
  /** Write a typed event to the stream. */
  write(event: ChatEvent): void;
  /** Write an SSE comment line (`: ...`). Visible only as a heartbeat to
   *  the underlying transport — proxies and the browser treat it as no-op. */
  comment(text: string): void;
  /** Close the connection. Safe to call multiple times. */
  close(): void;
  /** True once `close()` has been called or the response has been destroyed. */
  readonly closed: boolean;
}

/**
 * Open an SSE response and return a writer.
 *
 * The writer kicks off a 25 s heartbeat timer (sends `: heartbeat\n\n`) so
 * intermediaries (cloudflare, nginx, etc.) don't close idle connections.
 * The timer is cleared when the response closes — caller doesn't need to
 * worry about it.
 */
export function openSseStream(res: ServerResponse): SseWriter {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy/CDN buffering — events must arrive at the client as
    // they're written, not in coalesced chunks.
    "X-Accel-Buffering": "no",
  });
  // Some platforms only flush headers after the first write; nudge them.
  // Casting because not every ServerResponse implementation exposes flushHeaders.
  type WithFlush = ServerResponse & { flushHeaders?: () => void };
  (res as WithFlush).flushHeaders?.();

  let closed = false;
  const heartbeat = setInterval(() => {
    if (closed || res.destroyed) return;
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      // Connection already gone — let the close handler clean up.
    }
  }, HEARTBEAT_INTERVAL_MS);

  const onResClose = () => {
    closed = true;
    clearInterval(heartbeat);
    // Remove ourselves from `res` so that under high connection churn
    // we don't leave a dangling listener that triggers Node's
    // MaxListenersExceededWarning. `close()` does the same cleanup if
    // the caller closes first; this branch covers the client-drops-
    // first case.
    res.off("close", onResClose);
  };
  res.on("close", onResClose);

  return {
    get closed() {
      return closed || res.destroyed;
    },
    write(event) {
      if (closed || res.destroyed) return;
      // Native SSE id field — EventSource lifts this into Last-Event-ID
      // on reconnect. We send it as the eventId on the JSON payload too
      // so non-EventSource readers (curl, tests) can recover it without
      // parsing SSE framing.
      try {
        res.write(`id: ${event.eventId}\n`);
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Connection dropped between checks — fall through; the close
        // handler will tidy up the heartbeat.
      }
    },
    comment(text) {
      if (closed || res.destroyed) return;
      try {
        res.write(`: ${text}\n\n`);
      } catch {
        // ignore
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.off("close", onResClose);
      try {
        res.end();
      } catch {
        // already ended
      }
    },
  };
}
