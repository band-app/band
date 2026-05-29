/**
 * Unit tests for the thin SSE writer. We feed it a stub ServerResponse and
 * assert exact bytes written. Pure utility, no real I/O.
 */

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/shared/chat-events";
import { openSseStream } from "../src/server/services/sse-writer";

interface RecordedResponse {
  chunks: string[];
  headers: { status: number; headers: Record<string, string> } | undefined;
  ended: boolean;
  destroyed: boolean;
  listeners: Map<string, Set<() => void>>;
  /** Trigger a registered listener (e.g. the underlying transport closing). */
  emit(event: string): void;
}

function makeStubResponse(): {
  res: Parameters<typeof openSseStream>[0];
  recorded: RecordedResponse;
} {
  const recorded: RecordedResponse = {
    chunks: [],
    headers: undefined,
    ended: false,
    destroyed: false,
    listeners: new Map(),
    emit(event) {
      const subs = recorded.listeners.get(event);
      if (!subs) return;
      for (const cb of [...subs]) cb();
    },
  };

  // Build a stub that matches the slice of ServerResponse the writer touches.
  const stub = {
    writeHead(status: number, headers: Record<string, string>) {
      recorded.headers = { status, headers };
      return this;
    },
    flushHeaders() {},
    write(chunk: string | Buffer) {
      if (recorded.destroyed) throw new Error("response destroyed");
      recorded.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    end() {
      recorded.ended = true;
    },
    on(event: string, cb: () => void) {
      let set = recorded.listeners.get(event);
      if (!set) {
        set = new Set();
        recorded.listeners.set(event, set);
      }
      set.add(cb);
      return this;
    },
    off(event: string, cb: () => void) {
      recorded.listeners.get(event)?.delete(cb);
      return this;
    },
    get destroyed() {
      return recorded.destroyed;
    },
  };

  return { res: stub as unknown as Parameters<typeof openSseStream>[0], recorded };
}

describe("sse-writer", () => {
  it("writes the expected response headers", () => {
    const { res, recorded } = makeStubResponse();
    openSseStream(res);

    expect(recorded.headers).toEqual({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  it("frames an event as id/event/data lines terminated by a blank line", () => {
    const { res, recorded } = makeStubResponse();
    const w = openSseStream(res);

    const evt: ChatEvent = {
      eventId: 42,
      type: "text-delta",
      id: "abc",
      delta: "hello",
    };
    w.write(evt);

    // Three writes per event: id, event, data with double newline.
    expect(recorded.chunks).toEqual([
      "id: 42\n",
      "event: text-delta\n",
      `data: ${JSON.stringify(evt)}\n\n`,
    ]);
  });

  it("writes consecutive events in order with monotonic ids", () => {
    const { res, recorded } = makeStubResponse();
    const w = openSseStream(res);

    w.write({ eventId: 1, type: "subscription-opened", sessionId: "s", taskRunning: true });
    w.write({ eventId: 2, type: "user-message", text: "hi" });
    w.write({ eventId: 3, type: "task-completed", taskId: "t-1" });

    const ids = recorded.chunks.filter((c) => c.startsWith("id: ")).map((c) => c.trim());
    expect(ids).toEqual(["id: 1", "id: 2", "id: 3"]);
  });

  it("writes comments as ': ...' lines (used for heartbeats)", () => {
    const { res, recorded } = makeStubResponse();
    const w = openSseStream(res);

    w.comment("hello");
    expect(recorded.chunks).toEqual([": hello\n\n"]);
  });

  it("close() ends the response and is idempotent", () => {
    const { res, recorded } = makeStubResponse();
    const w = openSseStream(res);

    w.close();
    expect(recorded.ended).toBe(true);
    expect(w.closed).toBe(true);

    // Calling again must not throw or write more.
    w.close();
    expect(recorded.chunks).toEqual([]);
  });

  it("write() after close() is a no-op", () => {
    const { res, recorded } = makeStubResponse();
    const w = openSseStream(res);

    w.close();
    w.write({ eventId: 1, type: "user-message", text: "ignored" });
    w.comment("ignored");
    expect(recorded.chunks).toEqual([]);
  });

  it("underlying close event flips `closed` to true and stops the heartbeat", () => {
    const { res, recorded } = makeStubResponse();
    const w = openSseStream(res);

    expect(w.closed).toBe(false);
    recorded.emit("close");
    expect(w.closed).toBe(true);

    // Subsequent writes are no-ops.
    w.write({ eventId: 1, type: "user-message", text: "no" });
    expect(recorded.chunks).toEqual([]);
  });
});
