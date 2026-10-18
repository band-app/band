import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldEvents, INITIAL_TRANSCRIPT } from "@band-app/client/transcript";
import type { ChatEvent } from "@band-app/shared/chat-events";
import { messageActions } from "../src/lib/chat/message-actions.ts";
import { buildRows } from "../src/lib/chat/rows.ts";

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
});
