import { crossOriginHub, hubUrl } from "./hub-config";

/** The part of `EventSource` the chat subscription uses. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export const EVENT_SOURCE_CLOSED = 2;

/**
 * SSE over `fetch`, so the request can carry `Authorization: Bearer`
 * (`EventSource` can't set headers). It does not reconnect: a dropped stream
 * ends in `error` with `readyState` CLOSED, and the caller reopens it with its
 * own cursor, the same path as a native source that gave up.
 */
class FetchEventSource extends EventTarget implements EventSourceLike {
  readyState = 0;
  private readonly abort = new AbortController();

  constructor(path: string) {
    super();
    void this.run(path);
  }

  close(): void {
    this.readyState = EVENT_SOURCE_CLOSED;
    this.abort.abort();
  }

  private async run(path: string): Promise<void> {
    const hub = crossOriginHub();
    try {
      const res = await fetch(hubUrl(path), {
        headers: {
          Accept: "text/event-stream",
          ...(hub?.token && { Authorization: `Bearer ${hub.token}` }),
        },
        credentials: "omit",
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE failed: HTTP ${res.status}`);
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n?/g, "\n");
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          this.dispatchFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Fall through to the error event; an abort from close() is silent.
    }
    if (this.abort.signal.aborted) return;
    this.readyState = EVENT_SOURCE_CLOSED;
    this.dispatchEvent(new Event("error"));
  }

  private dispatchFrame(frame: string): void {
    let type = "message";
    let id = "";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length === 0) return;
    this.dispatchEvent(new MessageEvent(type, { data: data.join("\n"), lastEventId: id }));
  }
}

/** A native `EventSource` when same-origin (cookie auth), else a fetch-based reader. */
export function openEventSource(path: string): EventSourceLike {
  if (!crossOriginHub()) return new EventSource(path, { withCredentials: true });
  return new FetchEventSource(path);
}
