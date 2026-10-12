import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldEvents, INITIAL_TRANSCRIPT } from "@band-app/client/transcript";
import type { ChatEvent } from "@band-app/shared/chat-events";
import { pickActiveChat } from "../src/lib/chat/active-chat.ts";
import { buildRows, copyText, rowType } from "../src/lib/chat/rows.ts";

let id = 0;
const update = (u: Record<string, unknown>): ChatEvent =>
  ({ type: "update", eventId: ++id, update: u }) as unknown as ChatEvent;
const say = (text: string) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const tool = (toolCallId: string, kind: string) =>
  update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: `${kind} it`,
    kind,
    status: "completed",
  });

function transcript(events: ChatEvent[]) {
  return foldEvents(INITIAL_TRANSCRIPT, events);
}

describe("buildRows", () => {
  const events: ChatEvent[] = [
    { type: "prompt", eventId: ++id, text: "fix it" } as ChatEvent,
    say("Looking."),
    tool("t1", "read"),
    tool("t2", "edit"),
    say("Done."),
    { type: "turn-ended", eventId: ++id, stopReason: "end_turn" } as ChatEvent,
  ];
  const state = transcript(events);

  it("makes a row per user message, per part of the turn, and a footer when it ends", () => {
    const rows = buildRows(state.messages, false);
    assert.deepEqual(
      rows.map((r) => rowType(r)),
      ["user", "text", "tools", "text", "footer"],
    );
  });

  it("ends a running turn with a thinking row instead of a footer", () => {
    const rows = buildRows(state.messages, true);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["user", "part", "part", "part", "thinking"],
    );
  });

  it("keeps the rows of a message the stream did not touch", () => {
    const before = buildRows(state.messages, false);
    const next = foldEvents(state, [
      { type: "prompt", eventId: ++id, text: "again" } as ChatEvent,
      say("Sure"),
    ]);
    const after = buildRows(next.messages, false);
    for (let i = 0; i < 4; i++) assert.equal(after[i], before[i]);
  });

  it("copies the message's text from any of its rows", () => {
    const rows = buildRows(state.messages, false);
    assert.equal(copyText(rows[0]), "fix it");
    assert.equal(copyText(rows[2]), "Looking.\n\nDone.");
  });

  it("shows no thinking row while the agent waits on the user", () => {
    const waiting = foldEvents(state, [
      { type: "prompt", eventId: ++id, text: "run tests" } as ChatEvent,
      {
        type: "permission",
        eventId: ++id,
        requestId: "r1",
        request: { toolCall: { toolCallId: "x", title: "Run tests" }, options: [] },
      } as unknown as ChatEvent,
    ]);
    const rows = buildRows(waiting.messages, true);
    assert.equal(rows[rows.length - 1].kind, "part");
  });
});

describe("pickActiveChat", () => {
  const chats = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("opens the desktop's active tab when it is a chat", () => {
    assert.equal(pickActiveChat(chats, { tabs: [{ id: "b", kind: "chat" }], active: "b" }), "b");
  });

  it("falls back to the first chat tab, then the first chat", () => {
    assert.equal(
      pickActiveChat(chats, {
        tabs: [
          { id: "t1", kind: "term" },
          { id: "c", kind: "chat" },
        ],
        active: "t1",
      }),
      "c",
    );
    assert.equal(
      pickActiveChat(chats, { tabs: [{ id: "gone", kind: "chat" }], active: "gone" }),
      "a",
    );
    assert.equal(pickActiveChat(chats, null), "a");
    assert.equal(pickActiveChat([], null), null);
  });
});
