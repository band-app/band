import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../src/index.ts";
import { HELLO, makeClient, once, startServer, TOKEN } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("handshake (S1)", () => {
  it("completes hello and ready, and the server sees the hello fields", async () => {
    const { server, url } = await startServer({ heartbeatMs: 1234 });
    const client = makeClient(url);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    const ready = once<{ heartbeatMs: number; sessionToken: string; resumed: boolean }>(
      client,
      "connected",
    );
    await client.connect();
    const r = await ready;
    assert.equal(r.heartbeatMs, 1234);
    assert.equal(r.resumed, false);
    assert.ok(r.sessionToken.length > 10);
    const session = server.getSession(HELLO.workerId);
    assert.ok(session);
    assert.deepEqual(session.hello.labels, { os: "linux" });
    assert.deepEqual(session.hello.roots, ["/work"]);
    assert.equal(session.hello.buildId, "build-1");
  });

  it("answers a bad token with rejected and does not reconnect", async () => {
    const { server, url } = await startServer();
    const client = makeClient(url, { token: "wrong" });
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    const reason = once<string>(client, "rejected");
    await assert.rejects(client.connect(), /rejected: bad token/);
    assert.equal(await reason, "bad token");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(server.getSession(HELLO.workerId), undefined);
  });

  it("answers a protocol mismatch with the version it needs", async () => {
    const { server, url } = await startServer();
    cleanups.push(() => server.close());
    const ws = new WebSocket(url);
    const reply = new Promise<{ type: string; need?: number }>((resolve) =>
      ws.once("message", (d) => resolve(JSON.parse(d.toString()))),
    );
    await once(ws, "open");
    ws.send(
      JSON.stringify({ type: "hello", ...HELLO, token: TOKEN, protocol: PROTOCOL_VERSION + 1 }),
    );
    assert.deepEqual(await reply, { type: "mismatch", need: PROTOCOL_VERSION });
    ws.close();
  });

  it("rejects a first frame that is not a hello", async () => {
    const { server, url } = await startServer();
    cleanups.push(() => server.close());
    const ws = new WebSocket(url);
    const reply = new Promise<{ type: string }>((resolve) =>
      ws.once("message", (d) => resolve(JSON.parse(d.toString()))),
    );
    await once(ws, "open");
    ws.send("not json");
    assert.equal((await reply).type, "rejected");
  });

  it("rejects a hello whose fields have the wrong shape", async () => {
    const { server, url } = await startServer();
    cleanups.push(() => server.close());
    const bad = [
      { labels: { os: 1 } },
      { roots: "/work" },
      { mode: "weird" },
      { resume: { "1": -5 } },
      { resume: { "1": 1.5 } },
      { token: 42 },
    ];
    for (const patch of bad) {
      const ws = new WebSocket(url);
      const reply = new Promise<{ type: string; reason?: string }>((resolve) =>
        ws.once("message", (d) => resolve(JSON.parse(d.toString()))),
      );
      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          ...HELLO,
          token: TOKEN,
          ...patch,
        }),
      );
      const r = await reply;
      assert.equal(r.type, "rejected", JSON.stringify(patch));
      assert.match(r.reason ?? "", /malformed hello/);
    }
    assert.equal(server.getSession(HELLO.workerId), undefined);
  });
});
