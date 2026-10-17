import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WriteBatcher } from "../src/lib/terminal/write-batcher.ts";

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A send whose calls the test resolves or rejects by hand. */
function fakeSend() {
  const calls: { bytes: Uint8Array; done: () => void; fail: () => void }[] = [];
  const send = (b: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ bytes: b, done: resolve, fail: () => reject(new Error("view gone")) });
    });
  return { calls, send };
}

describe("WriteBatcher", () => {
  it("joins frames that arrive in the same tick into one write, in order", async () => {
    const { calls, send } = fakeSend();
    const b = new WriteBatcher(send);
    b.push(Uint8Array.of(1, 2), () => {});
    b.push(Uint8Array.of(3), () => {});
    b.push(Uint8Array.of(4, 5), () => {});
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0].bytes], [1, 2, 3, 4, 5]);
  });

  it("keeps one write in flight and limits a batch to 64 KB", async () => {
    const { calls, send } = fakeSend();
    const b = new WriteBatcher(send);
    for (let i = 0; i < 5; i++) b.push(bytes(30 * 1024, i + 1), () => {});
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bytes.length, 60 * 1024);
    calls[0].done();
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].bytes.length, 60 * 1024);
    calls[1].done();
    await tick();
    assert.equal(calls[2].bytes.length, 30 * 1024);
    // Order across batches is the push order.
    assert.equal(calls[0].bytes[0], 1);
    assert.equal(calls[1].bytes[0], 3);
    assert.equal(calls[2].bytes[0], 5);
  });

  it("sends a single frame larger than the limit whole", async () => {
    const { calls, send } = fakeSend();
    const b = new WriteBatcher(send);
    b.push(bytes(100 * 1024), () => {});
    await tick();
    assert.equal(calls[0].bytes.length, 100 * 1024);
  });

  it("runs the parsed callbacks only after the write resolves", async () => {
    const { calls, send } = fakeSend();
    const b = new WriteBatcher(send);
    const parsed: number[] = [];
    b.push(bytes(1), () => parsed.push(1));
    b.push(bytes(1), () => parsed.push(2));
    await tick();
    assert.deepEqual(parsed, []);
    calls[0].done();
    await tick();
    assert.deepEqual(parsed, [1, 2]);
  });

  it("runs parsed for queued chunks that clear() drops, and not twice", async () => {
    const { calls, send } = fakeSend();
    const b = new WriteBatcher(send);
    const parsed: string[] = [];
    b.push(bytes(60 * 1024), () => parsed.push("a"));
    b.push(bytes(60 * 1024), () => parsed.push("b"));
    await tick();
    assert.equal(calls.length, 1);
    b.clear();
    assert.deepEqual(parsed, ["b"]);
    calls[0].done();
    await tick();
    assert.deepEqual(parsed, ["b", "a"]);
    assert.equal(calls.length, 1);
  });

  it("counts a rejected write as taken", async () => {
    const { calls, send } = fakeSend();
    const b = new WriteBatcher(send);
    const parsed: number[] = [];
    b.push(bytes(1), () => parsed.push(1));
    await tick();
    calls[0].fail();
    await tick();
    assert.deepEqual(parsed, [1]);
    // The queue still works afterwards.
    b.push(bytes(1), () => parsed.push(2));
    await tick();
    calls[1].done();
    await tick();
    assert.deepEqual(parsed, [1, 2]);
  });

  it("drops the queue and reports an overflow past queueCap", async () => {
    const { calls, send } = fakeSend();
    let overflows = 0;
    const b = new WriteBatcher(send, () => overflows++);
    b.queueCap = 100 * 1024;
    const parsed: number[] = [];
    b.push(bytes(60 * 1024), () => parsed.push(1));
    await tick(); // in flight, so not counted as queued
    b.push(bytes(60 * 1024), () => parsed.push(2));
    assert.equal(overflows, 0);
    b.push(bytes(60 * 1024), () => parsed.push(3));
    assert.equal(overflows, 1);
    assert.deepEqual(parsed, [2, 3]);
    calls[0].done();
    await tick();
    assert.equal(calls.length, 1);
  });
});
