/**
 * The SSE reader against a real local HTTP server that streams chat events
 * and drops the connection after N events. The server honours `lastEventId`
 * like the hub's `/api/chats/:id/events`, so the reader must reconnect, resume
 * after the last event and deliver every event exactly once.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { openChatStream } from "../src/chat-stream.ts";
import { parseSseFrame } from "../src/sse.ts";

const TOTAL = 10;
const DROP_AFTER = 3;

let server: Server;
let base: string;
const requests: string[] = [];

function frame(id: number): string {
  const event = { type: "prompt", eventId: id, text: `m${id}` };
  return `id: ${id}\nevent: prompt\ndata: ${JSON.stringify(event)}\n\n`;
}

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.headers.accept !== "text/event-stream" || !url.pathname.endsWith("/events")) {
      res.writeHead(404).end();
      return;
    }
    const after = Number(url.searchParams.get("lastEventId") ?? 0);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // A comment frame and a split write exercise the parser.
    res.write(": keepalive\n\n");
    let sent = 0;
    for (let id = after + 1; id <= TOTAL && sent < DROP_AFTER; id++, sent++) {
      const text = frame(id);
      res.write(text.slice(0, 7));
      res.write(text.slice(7));
    }
    // Drop the connection mid-stream, except once the log is complete.
    // The empty write's callback fires once the frames above are flushed.
    if (after + sent >= TOTAL) res.end();
    else res.write("", () => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("parseSseFrame", () => {
  it("reads event, id and multi-line data, and skips comments", () => {
    assert.deepEqual(parseSseFrame("id: 4\nevent: update\ndata: a\ndata: b"), {
      event: "update",
      id: "4",
      data: "a\nb",
    });
    assert.equal(parseSseFrame(": keepalive"), null);
  });
});

describe("openChatStream", () => {
  it("reconnects after a drop, resumes after the last event and delivers each event once", async () => {
    const received: number[] = [];
    let cursor: { lastEventId?: number; revision: number } = { revision: 0 };
    const done = new Promise<void>((resolve) => {
      const stream = openChatStream({
        fetch: (path, init) => fetch(`${base}${path}`, init),
        chatId: "chat/1",
        getCursor: () => cursor,
        initialBackoffMs: 10,
        maxBackoffMs: 50,
        onEvent: (event) => {
          received.push(event.eventId);
          cursor = { lastEventId: event.eventId, revision: 0 };
          if (event.eventId === TOTAL) {
            stream.close();
            resolve();
          }
        },
      });
    });
    await done;
    assert.deepEqual(
      received,
      Array.from({ length: TOTAL }, (_, i) => i + 1),
    );
    // 10 events at 3 per connection: 4 connections, each resuming after the last id.
    assert.equal(requests.length, 4);
    assert.match(requests[0] ?? "", /^\/api\/chats\/chat%2F1\/events\?$/);
    assert.match(requests[1] ?? "", /lastEventId=3&revision=0/);
    assert.match(requests[3] ?? "", /lastEventId=9&revision=0/);
  });
});
