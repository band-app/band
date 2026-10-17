import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldEvents, INITIAL_TRANSCRIPT } from "@band-app/client/transcript";
import type { ChatEvent } from "@band-app/shared/chat-events";

import { messageActions, rowTime, timeAgo } from "../src/lib/chat/message-actions.ts";
import { buildRows } from "../src/lib/chat/rows.ts";

describe("timeAgo", () => {
  const now = 10_000_000_000;
  it("counts in the largest whole unit", () => {
    assert.equal(timeAgo(now - 5_000, now), "just now");
    assert.equal(timeAgo(now - 59_000, now), "just now");
    assert.equal(timeAgo(now - 60_000, now), "1 minute ago");
    assert.equal(timeAgo(now - 5 * 60_000, now), "5 minutes ago");
    assert.equal(timeAgo(now - 3 * 3_600_000, now), "3 hours ago");
    assert.equal(timeAgo(now - 2 * 86_400_000, now), "2 days ago");
  });
});

describe("message actions", () => {
  let id = 0;
  const events = [
    { type: "prompt", eventId: ++id, text: "fix it", createdAt: 1234 },
    { type: "turn-started", eventId: ++id },
    {
      type: "update",
      eventId: ++id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
    },
  ] as unknown as ChatEvent[];
  const rows = buildRows(foldEvents(INITIAL_TRANSCRIPT, events).messages, false);

  it("offers Copy on a row with text, and none on a thinking row", () => {
    assert.deepEqual(messageActions(rows[0]!), ["copy"]);
    assert.deepEqual(messageActions({ kind: "thinking", key: "thinking" }), []);
  });

  it("reads the time a message was sent", () => {
    assert.equal(rowTime({ kind: "thinking", key: "thinking" }), undefined);
    assert.equal(rowTime(rows[0]!), 1234);
  });
});
