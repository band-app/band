/**
 * Reducer tests — drive `chatEventReducer` with hand-crafted event sequences
 * that mirror what the server actually emits. Pure, no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  applyEvents,
  type ChatSubscriptionState,
  chatEventReducer,
  INITIAL_STATE,
} from "../src/components/chat/chat-event-reducer";
import type { ChatEvent } from "../src/lib/chat-events";

/** Tiny helper to build a sequenced event log without repeating eventIds. */
function seq(events: Array<Omit<ChatEvent, "eventId">>): ChatEvent[] {
  return events.map((e, i) => ({ ...e, eventId: i + 1 }) as ChatEvent);
}

describe("chatEventReducer", () => {
  it("initial state has no messages and is idle", () => {
    expect(INITIAL_STATE.messages).toEqual([]);
    expect(INITIAL_STATE.status).toBe("idle");
    expect(INITIAL_STATE.taskRunning).toBe(false);
    expect(INITIAL_STATE.lastEventId).toBeUndefined();
  });

  it("subscription-opened sets sessionId and taskRunning", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([{ type: "subscription-opened", sessionId: "s1", taskRunning: true }]),
    );
    expect(state.sessionId).toBe("s1");
    expect(state.taskRunning).toBe(true);
    expect(state.status).toBe("streaming");
    expect(state.lastEventId).toBe(1);
  });

  it("session-resolved updates sessionId", () => {
    const state = applyEvents(INITIAL_STATE, seq([{ type: "session-resolved", sessionId: "abc" }]));
    expect(state.sessionId).toBe("abc");
  });

  it("user-message appends a user message with text and files", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        {
          type: "user-message",
          text: "hello",
          files: [{ mediaType: "image/png", url: "/api/uploads/x.png", filename: "x.png" }],
        },
      ]),
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].parts).toEqual([
      { type: "text", text: "hello" },
      { type: "file", mediaType: "image/png", url: "/api/uploads/x.png", filename: "x.png" },
    ]);
  });

  it("full turn: user-message → task-started → text-deltas → task-completed", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "What is this?" },
        { type: "task-started", taskId: "t1" },
        { type: "session-resolved", sessionId: "sess-1" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "It's " },
        { type: "text-delta", id: "p1", delta: "a project." },
        { type: "text-end", id: "p1" },
        { type: "task-completed", taskId: "t1", durationMs: 1500 },
      ]),
    );

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[1].role).toBe("assistant");
    const textPart = state.messages[1].parts[0] as { type: string; text: string };
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("It's a project.");
    expect(state.taskRunning).toBe(false);
    expect(state.status).toBe("completed");
    expect(state.sessionId).toBe("sess-1");
    expect(state.currentAssistantId).toBeUndefined();
  });

  it("tool call lifecycle: input then output replaces in-place", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "read README" },
        { type: "task-started", taskId: "t1" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "Reading..." },
        {
          type: "tool-input-available",
          toolCallId: "tc-1",
          toolName: "Read",
          input: { path: "README.md" },
          displayTitle: "Read README.md",
        },
        {
          type: "tool-output-available",
          toolCallId: "tc-1",
          output: "# Project\n\nHello",
        },
        { type: "task-completed", taskId: "t1" },
      ]),
    );

    const assistant = state.messages[1];
    expect(assistant.parts).toHaveLength(2); // text + tool
    const toolPart = assistant.parts[1] as unknown as {
      type: string;
      toolCallId: string;
      state: string;
      output: string;
      input: { path: string };
      title: string;
    };
    expect(toolPart.type).toBe("tool-Read");
    expect(toolPart.toolCallId).toBe("tc-1");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("# Project\n\nHello");
    expect(toolPart.input).toEqual({ path: "README.md" });
    expect(toolPart.title).toBe("Read README.md");
  });

  it("tool error sets output-error state", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "do thing" },
        { type: "task-started", taskId: "t1" },
        {
          type: "tool-input-available",
          toolCallId: "tc-1",
          toolName: "Read",
          input: { path: "missing.md" },
        },
        {
          type: "tool-output-available",
          toolCallId: "tc-1",
          output: "ENOENT",
          isError: true,
        },
        { type: "task-error", taskId: "t1", message: "Agent stopped" },
      ]),
    );

    const assistant = state.messages[1];
    // No text part — the tool is the first (and only) part on the assistant message.
    const toolPart = assistant.parts[0] as unknown as {
      type: string;
      state: string;
      errorText: string;
    };
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toBe("ENOENT");
    expect(state.status).toBe("error");
    expect(state.taskErrorMessage).toBe("Agent stopped");
  });

  it("queue-updated replaces the queue wholesale", () => {
    let state = chatEventReducer(INITIAL_STATE, {
      eventId: 1,
      type: "queue-updated",
      messages: [{ id: "q1", text: "first" }],
    });
    expect(state.queuedMessages).toEqual([{ id: "q1", text: "first" }]);

    state = chatEventReducer(state, {
      eventId: 2,
      type: "queue-updated",
      messages: [
        { id: "q1", text: "first" },
        { id: "q2", text: "second" },
      ],
    });
    expect(state.queuedMessages).toHaveLength(2);

    state = chatEventReducer(state, { eventId: 3, type: "queue-updated", messages: [] });
    expect(state.queuedMessages).toEqual([]);
  });

  it("usage event updates usage", () => {
    const state = chatEventReducer(INITIAL_STATE, {
      eventId: 1,
      type: "usage",
      data: { inputTokens: 100, outputTokens: 50, contextTokens: 150 },
    });
    expect(state.usage).toEqual({ inputTokens: 100, outputTokens: 50, contextTokens: 150 });
  });

  it("two text-deltas with the same part id merge into a single text part", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "task-started", taskId: "t1" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "Hello" },
        { type: "text-delta", id: "p1", delta: " world" },
      ]),
    );
    const asst = state.messages[0];
    expect(asst.parts).toHaveLength(1);
    expect((asst.parts[0] as { text: string }).text).toBe("Hello world");
  });

  it("text → tool → text creates separate parts on the same assistant message", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "do it" },
        { type: "task-started", taskId: "t1" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "Step 1: " },
        { type: "text-end", id: "p1" },
        {
          type: "tool-input-available",
          toolCallId: "tc-1",
          toolName: "Read",
          input: {},
        },
        { type: "tool-output-available", toolCallId: "tc-1", output: "ok" },
        { type: "text-start", id: "p2" },
        { type: "text-delta", id: "p2", delta: "Done." },
        { type: "task-completed", taskId: "t1" },
      ]),
    );

    const asst = state.messages[1];
    expect(asst.role).toBe("assistant");
    // text (p1) + tool + text (p2)
    expect(asst.parts).toHaveLength(3);
    expect((asst.parts[0] as { type: string }).type).toBe("text");
    expect((asst.parts[1] as { type: string }).type).toBe("tool-Read");
    expect((asst.parts[2] as { type: string }).type).toBe("text");
  });

  it("applying the suffix of an event log yields the same final state as the whole log", () => {
    const fullSequence: Array<Omit<ChatEvent, "eventId">> = [
      { type: "user-message", text: "hi" },
      { type: "task-started", taskId: "t1" },
      { type: "session-resolved", sessionId: "s1" },
      { type: "text-start", id: "p1" },
      { type: "text-delta", id: "p1", delta: "Hello" },
      { type: "text-delta", id: "p1", delta: ", " },
      { type: "text-delta", id: "p1", delta: "world!" },
      { type: "task-completed", taskId: "t1" },
    ];
    const full = applyEvents(INITIAL_STATE, seq(fullSequence));

    // Apply first half, take snapshot, apply suffix. Must converge.
    const half = Math.floor(fullSequence.length / 2);
    const firstHalf = applyEvents(INITIAL_STATE, seq(fullSequence.slice(0, half)));
    const recovered = applyEvents(firstHalf, seq(fullSequence).slice(half));

    expect(recovered.messages).toEqual(full.messages);
    expect(recovered.status).toBe(full.status);
    expect(recovered.sessionId).toBe(full.sessionId);
    expect(recovered.lastEventId).toBe(full.lastEventId);
  });

  it("lastEventId advances monotonically", () => {
    let state = INITIAL_STATE;
    for (const evt of seq([
      { type: "subscription-opened", taskRunning: false },
      { type: "user-message", text: "a" },
      { type: "task-started", taskId: "t1" },
    ])) {
      state = chatEventReducer(state, evt);
      expect(state.lastEventId).toBe(evt.eventId);
    }
  });

  it("optimistic user-message (negative eventId) is replaced by the real echo", () => {
    // Hook dispatches the pending event immediately on send().
    const stateAfterOptimistic = chatEventReducer(INITIAL_STATE, {
      type: "user-message",
      text: "ping",
      eventId: -123, // synthetic negative — pending
    });
    expect(stateAfterOptimistic.messages).toHaveLength(1);
    // Ids use the internal `messageIdCounter`, not `event.eventId`, so they
    // stay unique across multiple sessions whose server-side eventIds collide.
    expect(stateAfterOptimistic.messages[0].id).toBe("u-pending-1");

    // Server later echoes the same prompt with a real positive eventId.
    const stateAfterEcho = chatEventReducer(stateAfterOptimistic, {
      type: "user-message",
      text: "ping",
      eventId: 2,
    });
    // The pending bubble was replaced — not duplicated. Id is the same
    // root counter (1) with the `pending-` prefix stripped so React keeps
    // the same component mounted across the replace.
    expect(stateAfterEcho.messages).toHaveLength(1);
    expect(stateAfterEcho.messages[0].id).toBe("u-1");
    expect((stateAfterEcho.messages[0].parts[0] as { text: string }).text).toBe("ping");
  });

  it("real user-message with mismatched text appends rather than replaces a pending bubble", () => {
    const pending = chatEventReducer(INITIAL_STATE, {
      type: "user-message",
      text: "ping",
      eventId: -1,
    });
    const after = chatEventReducer(pending, {
      type: "user-message",
      text: "different message",
      eventId: 2,
    });
    expect(after.messages).toHaveLength(2);
    // Counter increments: first user-message → counter 1, second → counter 2.
    expect(after.messages[0].id).toBe("u-pending-1");
    expect(after.messages[1].id).toBe("u-2");
  });

  it("ids stay unique even when multiple sessions reuse eventId=2 for user-message", () => {
    // Simulates JSONL backfill: two prior sessions, both emitting their
    // user-message at the server-side eventId=2. Before the counter fix,
    // both messages got id="u-2" and React threw "duplicate keys".
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "from session A" },
        { type: "user-message", text: "from session B" },
      ]),
    );
    const ids = state.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  /**
   * Regression: opening a workspace with prior session history left the
   * thinking indicator spinning forever. JSONL backfill replays past turns
   * as `user-message → text-start → text-delta → text-end → ...` with no
   * closing `task-completed` event (those are live-only). The reducer
   * unconditionally flipped `status` to `"streaming"` on every text event,
   * so an idle chat with history would surface as `isStreaming === true`.
   *
   * Under the fix, stream-state events only enter `"streaming"` when a
   * task is *actually* running (`taskRunning === true`).
   */
  it("JSONL backfill (no task-started) leaves status idle, not streaming", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        // subscription-opened with no live task — matches the cold-load
        // case where the chat has prior JSONL but nothing in flight.
        { type: "subscription-opened", sessionId: "sess-old", taskRunning: false },
        // Now JSONL backfill — same shape the server's `jsonlMessageToEvents`
        // emits. No `task-started` / `task-completed` framing.
        { type: "user-message", text: "first historical message" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "historical reply" },
        { type: "text-end", id: "p1" },
        { type: "user-message", text: "second historical message" },
        { type: "text-start", id: "p2" },
        { type: "text-delta", id: "p2", delta: "another historical reply" },
        { type: "text-end", id: "p2" },
      ]),
    );

    expect(state.taskRunning).toBe(false);
    expect(state.status).toBe("idle");
    // Sanity: the messages were still ingested correctly.
    expect(state.messages).toHaveLength(4);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[1].role).toBe("assistant");
    expect((state.messages[1].parts[0] as { text: string }).text).toBe("historical reply");
  });

  /**
   * Sister test to "JSONL backfill leaves status idle": confirms that
   * once a task IS running, text events flip status to "streaming"
   * exactly as before.
   */
  it("text events still flip status to streaming while a task is running", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "go" },
        { type: "task-started", taskId: "t1" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "in progress" },
      ]),
    );

    expect(state.taskRunning).toBe(true);
    expect(state.status).toBe("streaming");
  });

  it("generic error appends an inline italic note to the current assistant message", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "x" },
        { type: "task-started", taskId: "t1" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "partial " },
        { type: "error", message: "agent timeout" },
        { type: "task-error", taskId: "t1", message: "agent timeout" },
      ]),
    );
    const asst = state.messages[1];
    expect(asst.parts).toHaveLength(2);
    expect((asst.parts[1] as { text: string }).text).toContain("agent timeout");
    expect(state.status).toBe("error");
  });

  /**
   * Edge case identified in the audit: `tool-output-available` arriving
   * with no `currentAssistantId` (no live assistant message in flight).
   * Real-world trigger is a malformed JSONL transcript with an orphan
   * `tool_result` block, or an event ordering race where the assistant
   * message was cleared by a `task-completed` before the tool result
   * arrived. The reducer must drop the orphan silently — appending it
   * to a stale assistant or creating a new one would corrupt the chat.
   */
  it("orphan tool-output-available (no currentAssistantId) is dropped, lastEventId advances", () => {
    const before: ChatSubscriptionState = {
      ...INITIAL_STATE,
      lastEventId: 5,
      messages: [],
    };
    const after = chatEventReducer(before, {
      type: "tool-output-available",
      toolCallId: "orphan-id",
      output: "this should not show up",
      isError: false,
      eventId: 6,
    });
    // No new messages, no new tool part anywhere.
    expect(after.messages).toEqual([]);
    expect(after.currentAssistantId).toBeUndefined();
    // Cursor still advances — we processed the event, we just had
    // nothing to attach it to.
    expect(after.lastEventId).toBe(6);
  });

  /**
   * Edge case: `text-end` arrives without a preceding `text-start` —
   * harmless (no state mutation expected) but the cursor must still
   * advance so a subsequent reconnect with `Last-Event-ID` doesn't
   * re-deliver the orphan event.
   */
  it("text-end without a matching text-start is a no-op on messages but advances the cursor", () => {
    const before: ChatSubscriptionState = { ...INITIAL_STATE, lastEventId: 9 };
    const after = chatEventReducer(before, {
      type: "text-end",
      id: "phantom-part",
      eventId: 10,
    });
    expect(after.messages).toEqual([]);
    expect(after.currentAssistantId).toBeUndefined();
    expect(after.lastEventId).toBe(10);
  });

  /**
   * Concurrent-send race protection: two `user-message` events with the
   * same text arriving back-to-back BOTH as pending (negative eventId)
   * must each produce their own bubble — no implicit dedupe. The
   * optimistic-replace logic only triggers when a NEW positive-id echo
   * comes in to replace a PENDING bubble; two pending bubbles for the
   * same text (e.g. user double-clicks send before React commits the
   * first dispatch) are kept distinct so the reducer doesn't conflate
   * them. The downstream `taskRunning` gate in `send()` is what
   * prevents the double-dispatch in practice; this test guards the
   * reducer's own behaviour if that gate ever races.
   */
  it("two pending user-messages with the same text both render (no implicit dedupe)", () => {
    const state = applyEvents(INITIAL_STATE, [
      { type: "user-message", text: "boom", eventId: -100 },
      { type: "user-message", text: "boom", eventId: -101 },
    ] as ChatEvent[]);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].id.startsWith("u-pending-")).toBe(true);
    expect(state.messages[1].id.startsWith("u-pending-")).toBe(true);
    expect(state.messages[0].id).not.toBe(state.messages[1].id);
  });
});
