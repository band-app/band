import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { type Channel, PROTOCOL_VERSION } from "../src/index.ts";
import { makeClient, nextSession, startServer, waitFor } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const WINDOW = 32 * 1024;

async function connected(window = WINDOW) {
  const { server, url } = await startServer({ window });
  const client = makeClient(url, { window });
  cleanups.push(
    () => client.close(),
    () => server.close(),
  );
  const serverSession = nextSession(server);
  await client.connect();
  return { server, client, hub: await serverSession, worker: client.session };
}

function peerChannel(session: {
  once(e: "channel", cb: (c: Channel) => void): unknown;
}): Promise<Channel> {
  return new Promise((resolve) => session.once("channel", resolve));
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("channels (S3)", () => {
  it("streams 10 MB through a small window intact and in order", async () => {
    const { hub, worker } = await connected();
    const incoming = peerChannel(hub);
    const out = worker.openChannel("pty", { id: "t1" });
    const payload = randomBytes(10 * 1024 * 1024);

    const sender = (async () => {
      for (let off = 0; off < payload.length; off += 100_000) {
        await out.send(payload.subarray(off, off + 100_000));
        assert.ok(out.bytesInFlight <= WINDOW, `in flight ${out.bytesInFlight} exceeds window`);
      }
      out.end();
    })();

    const ch = await incoming;
    assert.equal(ch.name, "pty");
    assert.deepEqual(ch.meta, { id: "t1" });
    const got = await ch.readAll();
    await sender;
    assert.equal(got.length, payload.length);
    assert.equal(sha(got), sha(payload));
  });

  it("pauses the sender when the reader does not consume", async () => {
    const { hub, worker } = await connected();
    const incoming = peerChannel(hub);
    const out = worker.openChannel("flood");
    const chunk = Buffer.alloc(8 * 1024, 7);
    let resolved = false;
    const sending = out.send(Buffer.concat(Array.from({ length: 64 }, () => chunk))).then(() => {
      resolved = true;
    });
    const ch = await incoming;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(resolved, false, "send finished although nobody read");
    assert.ok(out.bytesInFlight <= WINDOW);
    assert.ok(out.bytesBlocked > 0, "nothing is held back by credit");

    // Reading releases credit and the rest flows.
    let total = 0;
    const reader = (async () => {
      for await (const c of ch) {
        total += c.length;
        if (total === 64 * chunk.length) break;
      }
    })();
    await sending;
    await reader;
    assert.equal(total, 64 * chunk.length);
  });

  it("carries data both ways on one channel and ends cleanly", async () => {
    const { hub, worker } = await connected();
    const incoming = peerChannel(hub);
    const w = worker.openChannel("echo");
    const h = await incoming;
    void (async () => {
      for await (const c of h) await h.send(Buffer.from(c.toString().toUpperCase()));
      h.end();
    })();
    await w.send(Buffer.from("hello"));
    const it = w[Symbol.asyncIterator]();
    assert.equal((await it.next()).value.toString(), "HELLO");
    w.end();
    assert.equal((await it.next()).done, true);
  });

  it("fails the peer's reader on reset", async () => {
    const { hub, worker } = await connected();
    const incoming = peerChannel(hub);
    const w = worker.openChannel("x");
    const h = await incoming;
    const read = h.readAll();
    w.reset("changed my mind");
    await assert.rejects(read, /changed my mind/);
  });
});

describe("resume after a dropped socket (S4)", () => {
  /** Reads a channel to its end and kills the socket every `every` bytes, so drops land mid-stream. */
  async function readWithDrops(ch: Channel, kill: () => void, every: number, max: number) {
    const parts: Buffer[] = [];
    let total = 0;
    let next = every;
    let drops = 0;
    for await (const c of ch) {
      parts.push(c);
      total += c.length;
      if (total >= next && drops < max) {
        next += every;
        drops++;
        kill();
      }
    }
    return { data: Buffer.concat(parts), drops };
  }

  it("delivers every byte exactly once while the socket is killed repeatedly", async () => {
    const { hub, worker } = await connected(16 * 1024);
    const incoming = peerChannel(hub);
    const out = worker.openChannel("chaos");
    const payload = randomBytes(3 * 1024 * 1024);
    const sender = (async () => {
      for (let off = 0; off < payload.length; off += 50_000)
        await out.send(payload.subarray(off, off + 50_000));
      out.end();
    })();
    const ch = await incoming;
    const { data, drops } = await readWithDrops(ch, () => hub.dropConnection(), 150_000, 15);
    await sender;
    assert.ok(drops >= 10, `only ${drops} drops, the test did not exercise resume`);
    assert.equal(data.length, payload.length);
    assert.equal(sha(data), sha(payload));
  });

  it("resumes the other direction too, with data from hub to worker", async () => {
    const { hub, worker } = await connected(16 * 1024);
    const out = hub.openChannel("down");
    const incoming = peerChannel(worker);
    const payload = randomBytes(1024 * 1024);
    const sender = (async () => {
      for (let off = 0; off < payload.length; off += 30_000)
        await out.send(payload.subarray(off, off + 30_000));
      out.end();
    })();
    const ch = await incoming;
    const { data, drops } = await readWithDrops(ch, () => worker.dropConnection(), 100_000, 8);
    await sender;
    assert.ok(drops >= 5, `only ${drops} drops`);
    assert.equal(sha(data), sha(payload));
  });

  it("keeps a channel opened while disconnected and delivers its data after the reconnect", async () => {
    const { hub, worker } = await connected();
    hub.dropConnection();
    await waitFor(() => !worker.attached, 2000, "worker to notice the drop");
    const out = worker.openChannel("offline");
    const sent = out.send(Buffer.from("queued while down"));
    out.end();
    const ch = await peerChannel(hub);
    assert.equal((await ch.readAll()).toString(), "queued while down");
    await sent;
  });

  it("fails channels when the hub dropped the session before the worker came back", async () => {
    const { server, url } = await startServer({ window: WINDOW, resumeTtlMs: 40 });
    const client = makeClient(url, { window: WINDOW, reconnect: { minMs: 300, maxMs: 300 } });
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    const serverSession = nextSession(server);
    await client.connect();
    const hub = await serverSession;
    const incoming = peerChannel(hub);
    const out = client.session.openChannel("doomed");
    await incoming;
    hub.dropConnection();
    await waitFor(() => out.failed, 3000, "channel failure after the session expired");
    await assert.rejects(out.send(Buffer.alloc(1)), /lost the link session/);
  });
  it("delivers data on a channel opened while the socket was down", async () => {
    const { server, url } = await startServer({ window: WINDOW });
    const client = makeClient(url, { window: WINDOW, reconnect: { minMs: 150, maxMs: 150 } });
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    const first = nextSession(server);
    await client.connect();
    const hub = await first;
    hub.dropConnection();
    await waitFor(() => !client.session.attached, 3000, "client to notice the drop");
    const out = client.session.openChannel("offline");
    const sending = out.send(Buffer.from("hello after outage"));
    const ch = await peerChannel(hub);
    await sending;
    out.end();
    assert.equal((await ch.readAll()).toString(), "hello after outage");
  });

  it("survives malformed frames and messages from an authenticated peer", async () => {
    const { server, url } = await startServer();
    const { WebSocket } = await import("ws");
    const { HELLO, TOKEN } = await import("./helpers.ts");
    cleanups.push(() => server.close());
    for (const bad of [
      Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0]),
      "null",
      "5",
      JSON.stringify({ jsonrpc: "2.0", method: "link.open" }),
    ]) {
      const ws = new WebSocket(url);
      await new Promise((r) => ws.once("open", r));
      const ready = new Promise((r) => ws.once("message", r));
      ws.send(
        JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, token: TOKEN, ...HELLO }),
      );
      await ready;
      const closed = new Promise((r) => ws.once("close", r));
      ws.send(bad);
      await closed;
    }
    assert.ok(server);
  });
});
