import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { OwnedChatInfo } from "@band-app/link";
import { ChatStore, type WireState } from "../src/chats/store.ts";

// A chats.db written by v0.61.0 has no `chat_wire_state` table. Opening it must add the table and
// leave what the old worker stored (the owned chat, its queue and events) as it was.
const OLD_SCHEMA = `
CREATE TABLE chat_events (
  id integer PRIMARY KEY AUTOINCREMENT, chat_id text NOT NULL, session_id text NOT NULL,
  revision integer NOT NULL, kind text NOT NULL, update_kind text, message_id text,
  tool_call_id text, turn_start integer DEFAULT false NOT NULL, payload text NOT NULL,
  created_at integer NOT NULL
);
CREATE TABLE owned_chats (
  chat_id text PRIMARY KEY, info text NOT NULL, launch text,
  seeded_through integer NOT NULL DEFAULT 0, seeded integer NOT NULL DEFAULT 0
);
CREATE TABLE id_blocks (start integer PRIMARY KEY, size integer NOT NULL);
CREATE TABLE queued_messages (
  id text PRIMARY KEY, chat_id text NOT NULL, seq integer NOT NULL, payload text NOT NULL
);
CREATE TABLE forwards (forward_id text PRIMARY KEY, reply text NOT NULL, at integer NOT NULL);
CREATE TABLE meta (key text PRIMARY KEY, value integer NOT NULL);
`;

const info = { chatId: "c1", agentId: "claude", worktreeId: "wt" } as unknown as OwnedChatInfo;

const state: WireState = {
  agentId: "a-1",
  sessionId: "s-1",
  specHash: "h",
  stdoutOffset: 1234,
  stderrOffset: 5,
  nextRequestId: 7,
  promptRequestId: 6,
  openClientRequests: [{ id: 6, method: "session/prompt" }],
  openAgentRequests: [{ id: 0, method: "session/request_permission", requestId: "r-1" }],
  turn: { seq: 1, taskId: "t-1", startedAt: 1 },
  revision: 1,
  work: { holds: [], taskToolCalls: [] },
  live: {},
};

describe("chats.db migration", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("adds the wire state table to a v0.61.0 file and keeps its rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "band-chats-db-"));
    dirs.push(dir);
    const file = join(dir, "chats.db");
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(OLD_SCHEMA);
    old
      .prepare("INSERT INTO owned_chats (chat_id, info, seeded) VALUES (?, ?, 1)")
      .run("c1", JSON.stringify(info));
    old
      .prepare("INSERT INTO queued_messages (id, chat_id, seq, payload) VALUES (?, ?, 1, ?)")
      .run("m1", "c1", JSON.stringify({ id: "m1", text: "queued before the update" }));
    old.close();

    const store = await ChatStore.open(file);
    try {
      assert.equal(store.ownedChat("c1")?.seeded, true);
      assert.deepEqual(
        store.queue("c1").map((m) => m.text),
        ["queued before the update"],
      );
      assert.equal(store.wireState("c1"), undefined);

      store.saveWireState("c1", state);
      assert.deepEqual(store.wireState("c1"), state);

      // The state goes with the chat.
      store.dropChat("c1", false);
      assert.equal(store.wireState("c1"), undefined);
    } finally {
      store.close();
    }
  });

  it("commits events and state together in one batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "band-chats-db-"));
    dirs.push(dir);
    const store = await ChatStore.open(join(dir, "chats.db"));
    try {
      store.saveChat(info);
      store.addBlock(1, 100);
      store.beginBatch();
      const id = store.takeId() as number;
      store.events.append({
        id,
        chatId: "c1",
        sessionId: "s-1",
        revision: 1,
        event: { type: "turn-started", taskId: "t-1" },
        turnStart: false,
        createdAt: 1,
      });
      store.saveWireState("c1", state);
      store.commitBatch();
      assert.equal(store.wireState("c1")?.stdoutOffset, 1234);
      assert.equal(store.events.maxChatId("c1"), id);
    } finally {
      store.close();
    }
  });
});
