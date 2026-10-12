/**
 * Server-sent events over `fetch`, for runtimes without a usable
 * `EventSource` (React Native) and for requests that must carry
 * `Authorization: Bearer`. A reader parses `text/event-stream` from a
 * streaming `Response` body; `openSseStream` adds reconnect with backoff.
 */

import type { HubFetch } from "./hub-client.ts";

export interface SseFrame {
  /** The `event:` field; `message` when the frame has none. */
  event: string;
  data: string;
  /** The `id:` field, or an empty string. */
  id: string;
}

/** One frame (the text between blank lines), or null for a comment or empty frame. */
export function parseSseFrame(frame: string): SseFrame | null {
  let event = "message";
  let id = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}

/** Read frames from a streaming body until it ends or `signal` aborts. */
export async function readSseBody(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const frame = parseSseFrame(buffer.slice(0, end));
      if (frame) onFrame(frame);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
    }
  }
}

export interface SseStreamOptions {
  fetch: HubFetch;
  /** Called before every (re)connect, so the path can carry the resume cursor. */
  path: () => string;
  onFrame: (frame: SseFrame) => void;
  /** `true` once the stream is open, `false` when it ends or fails. */
  onConnection?: (connected: boolean) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface SseStream {
  close(): void;
}

/**
 * Open a stream and keep it open: when it ends or fails, wait (doubling up
 * to `maxBackoffMs`, reset by a successful open) and connect again with a
 * fresh `path()`. Within one connection a frame whose numeric `id` is not
 * above the previous one is dropped.
 */
export function openSseStream(options: SseStreamOptions): SseStream {
  const initial = options.initialBackoffMs ?? 500;
  const max = options.maxBackoffMs ?? 10_000;
  const abort = new AbortController();
  let backoff = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run(): Promise<void> {
    let lastId: number | undefined;
    try {
      const res = await options.fetch(options.path(), {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE failed: HTTP ${res.status}`);
      backoff = initial;
      options.onConnection?.(true);
      await readSseBody(res.body, (frame) => {
        if (frame.id !== "") {
          const id = Number(frame.id);
          if (Number.isFinite(id)) {
            if (lastId !== undefined && id <= lastId) return;
            lastId = id;
          }
        }
        options.onFrame(frame);
      });
    } catch {
      // Falls through to the reconnect; an abort from close() is silent.
    }
    if (abort.signal.aborted) return;
    options.onConnection?.(false);
    timer = setTimeout(() => void run(), backoff);
    backoff = Math.min(backoff * 2, max);
  }

  void run();
  return {
    close() {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
      options.onConnection?.(false);
    },
  };
}
