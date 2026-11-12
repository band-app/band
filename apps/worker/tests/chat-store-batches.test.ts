import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ChatStore } from "../src/chats/store.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function open(): Promise<ChatStore> {
  const dir = mkdtempSync(join(tmpdir(), "band-chats-batch-"));
  dirs.push(dir);
  return ChatStore.open(join(dir, "chats.db"));
}

function append(store: ChatStore, id: number, chatId = "c1", taskId = "t") {
  store.events.append({
    id,
    chatId,
    sessionId: "s",
    revision: 1,
    event: { type: "turn-started", taskId },
    turnStart: false,
    createdAt: 1,
  });
}

describe("chat store batches", () => {
  it("reads only committed rows for replication", async () => {
    const store = await open();
    try {
      store.addBlock(1, 100);
      store.beginBatch();
      append(store, store.takeId() as number);
      assert.equal(store.readCommittedIdRange(1, 100, 10).length, 0);
      assert.equal(store.events.readIdRange(1, 100, 10).length, 1);
      store.commitBatch();
      assert.equal(store.readCommittedIdRange(1, 100, 10).length, 1);
    } finally {
      store.close();
    }
  });

  it("commits a batch left open and reports its age", async () => {
    const store = await open();
    try {
      store.addBlock(1, 100);
      let age = -1;
      store.onStuckBatch = (ms) => {
        age = ms;
      };
      store.beginBatch();
      append(store, store.takeId() as number);
      await new Promise((r) => setTimeout(r, 5_500));
      assert.ok(age >= 5_000, `age ${age}`);
      assert.equal(store.inTransaction, false);
      assert.equal(store.readCommittedIdRange(1, 100, 10).length, 1);
      // Later writes commit normally.
      append(store, store.takeId() as number);
      assert.equal(store.readCommittedIdRange(1, 100, 10).length, 2);
    } finally {
      store.close();
    }
  });

  it("reports a skipped row whose id holds different content, not an identical resend", async () => {
    const store = await open();
    try {
      append(store, 5, "c1", "a");
      const [same] = store.events.readIdRange(5, 5, 1);
      const conflicts: number[] = [];
      const note = (r: { id: number }): void => {
        conflicts.push(r.id);
      };
      store.events.insertRows([same], note);
      assert.deepEqual(conflicts, [] as number[]);
      store.events.insertRows([{ ...same, chatId: "c2" }], note);
      assert.deepEqual(conflicts, [5]);
    } finally {
      store.close();
    }
  });
});
