import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { HELLO, makeClient, once, startServer, TOKEN, waitFor } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("heartbeat (S5)", () => {
  it("marks a silent worker lost after three missed intervals", async () => {
    const { server, url } = await startServer({ heartbeatMs: 40 });
    cleanups.push(() => server.close());
    const lost = once(server, "lost");
    // A raw socket completes the handshake and then says nothing.
    const ws = new WebSocket(url);
    cleanups.push(() => ws.terminate());
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, token: TOKEN, ...HELLO }));
    const started = Date.now();
    await lost;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, `declared lost after ${elapsed} ms, before three 40 ms intervals`);
    assert.ok(elapsed < 1000);
  });

  it("keeps a healthy link alive well past the threshold", async () => {
    const { server, url } = await startServer({ heartbeatMs: 40 });
    const client = makeClient(url);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    let lost = 0;
    server.on("lost", () => lost++);
    client.on("lost", () => lost++);
    await client.connect();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(lost, 0);
    assert.ok(client.session.attached);
  });

  it("marks a silent hub lost on the client and reconnects", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(wss, "listening");
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.once("message", () => {
        ws.send(
          JSON.stringify({ type: "ready", sessionToken: "s", heartbeatMs: 40, resumed: false }),
        );
        // then silence
      });
    });
    const port = (wss.address() as { port: number }).port;
    const client = makeClient(`ws://127.0.0.1:${port}/`);
    cleanups.push(() => client.close());
    const lost = once(client, "lost");
    await client.connect();
    await lost;
    await waitFor(() => connections >= 2, 3000, "client to redial after losing the hub");
  });
});
