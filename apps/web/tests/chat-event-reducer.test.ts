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
import type { ChatEvent } from "../src/shared/chat-events";

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
   * Edge case: `tool-output-available` arriving with no message that
   * owns its `toolCallId` (no prior `tool-input-available`). Triggers:
   * a windowed cold subscribe (issue #572) whose replay includes a
   * `tool_result` whose `tool_use` is in an older, not-yet-loaded page;
   * or a reconnect that reorders the two. The reducer must NOT drop the
   * event (that was issue #509 — the dropped output left the tool stuck
   * in `input-available` forever once the input did arrive). Instead it
   * BUFFERS the output keyed by `toolCallId`; a later `tool-input-available`
   * or `prepend-messages` binds it. No message corruption, no warn.
   */
  it("orphan tool-output-available (no owner) is buffered, not dropped, lastEventId advances", () => {
    const before: ChatSubscriptionState = {
      ...INITIAL_STATE,
      lastEventId: 5,
      messages: [],
    };
    const after = chatEventReducer(before, {
      type: "tool-output-available",
      toolCallId: "orphan-id",
      output: "buffered until its tool_use loads",
      isError: false,
      eventId: 6,
    });
    // No new messages, no new tool part anywhere yet.
    expect(after.messages).toEqual([]);
    expect(after.currentAssistantId).toBeUndefined();
    // Cursor still advances — we processed the event.
    expect(after.lastEventId).toBe(6);
    // The output is parked, not lost.
    expect(after.pendingToolOutputs["orphan-id"]).toBeTruthy();
    expect(after.pendingToolOutputs["orphan-id"].output).toBe("buffered until its tool_use loads");
  });

  /**
   * Regression for issue #509 — Mode 1.
   *
   * The pre-fix reducer gated `tool-output-available` on
   * `state.currentAssistantId`, which is reset to `undefined` by
   * `user-message`. If the user typed a follow-up while a prior tool
   * was still running, the tool's eventual result was silently dropped,
   * leaving the part stuck in `input-available` (its orange pulse
   * never stopped).
   *
   * Under the fix, the reducer routes by globally-unique `toolCallId`
   * — the prior assistant message gets the output applied even though
   * `currentAssistantId` has been cleared.
   */
  it("regression #509: tool-output-available arriving AFTER a follow-up user-message resolves on the original assistant message", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "list files" },
        { type: "task-started", taskId: "t1" },
        {
          type: "tool-input-available",
          toolCallId: "tc-1",
          toolName: "Bash",
          input: { command: "ls" },
          displayTitle: "Bash(ls)",
        },
        // User types a follow-up while the first tool is still running.
        // This used to reset `currentAssistantId` and cause the next
        // tool-output to be dropped.
        { type: "user-message", text: "actually never mind" },
        // Late tool result for tc-1 — must still resolve on the
        // original assistant message.
        {
          type: "tool-output-available",
          toolCallId: "tc-1",
          output: "file1\nfile2",
        },
      ]),
    );

    // user, assistant (the one that owns tc-1), user
    expect(state.messages).toHaveLength(3);
    const originalAssistant = state.messages[1];
    expect(originalAssistant.role).toBe("assistant");
    const toolPart = originalAssistant.parts[0] as unknown as {
      type: string;
      state: string;
      output: string;
      input: { command: string };
      title: string;
    };
    expect(toolPart.type).toBe("tool-Bash");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("file1\nfile2");
    // Metadata preserved — no `tool-unknown` fallback (the pre-fix
    // Mode 2 failure would have wiped these).
    expect(toolPart.input).toEqual({ command: "ls" });
    expect(toolPart.title).toBe("Bash(ls)");
  });

  /**
   * Regression for issue #509 — `task-completed` reset path.
   *
   * Race between the agent flushing `tool-result` and broadcasting
   * `task-completed`: if the latter wins, the pre-fix reducer cleared
   * `currentAssistantId` and silently dropped the tool result. Under
   * the fix the result still resolves correctly.
   */
  it("regression #509: tool-output-available arriving AFTER task-completed resolves on the original assistant message", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "read README" },
        { type: "task-started", taskId: "t1" },
        {
          type: "tool-input-available",
          toolCallId: "tc-2",
          toolName: "Read",
          input: { path: "README.md" },
        },
        // task-completed races ahead of the final tool-result flush.
        { type: "task-completed", taskId: "t1" },
        {
          type: "tool-output-available",
          toolCallId: "tc-2",
          output: "# README",
        },
      ]),
    );

    const assistant = state.messages[1];
    const toolPart = assistant.parts[0] as unknown as {
      type: string;
      state: string;
      output: string;
    };
    expect(toolPart.type).toBe("tool-Read");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("# README");
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

  /**
   * Regression: the "Thinking…" indicator spinning forever after a missed
   * `task-completed` (issue — stuck thinking indicator).
   *
   * `task-completed` is a LIVE-ONLY broadcast: it's never written to the
   * JSONL transcript and is evicted from the in-memory session buffer past
   * MAX_BUFFER_SIZE (and wiped on server restart). So a client that was
   * detached when the task finished (tab hidden > 1s, dockview pane
   * deactivated, network blip, server restart) reconnects and never receives
   * the completion. The server's `subscription-opened` correctly reports
   * `taskRunning: false`, but the pre-fix reducer only ever upgraded
   * false→true (`state.taskRunning || event.taskRunning`), so the client's
   * `taskRunning` stayed true → `status` stayed `streaming` → the indicator
   * spun until a full page reload reset the reducer.
   *
   * Under the fix, with no optimistic task pending, `subscription-opened` is
   * authoritative in BOTH directions and settles a stale running belief to a
   * terminal state.
   */
  it("real task-started then subscription-opened{taskRunning:false} clears the stuck running state", () => {
    // A real (positive-eventId) task runs and streams an assistant reply,
    // then the client detaches before `task-completed` arrives.
    const running = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "do the thing" },
        { type: "task-started", taskId: "t1" },
        { type: "text-start", id: "p1" },
        { type: "text-delta", id: "p1", delta: "working on it" },
      ]),
    );
    expect(running.taskRunning).toBe(true);
    expect(running.status).toBe("streaming");
    expect(running.pendingOptimisticTask).toBe(false);

    // Reconnect: server reports the task is no longer running.
    const reconnected = chatEventReducer(running, {
      type: "subscription-opened",
      sessionId: "sess-1",
      taskRunning: false,
      eventId: -1,
    });

    expect(reconnected.taskRunning).toBe(false);
    // There's an assistant reply to show, so settle to `completed` — and
    // crucially NOT `submitting`/`streaming`, so `isStreaming` is false and
    // the thinking indicator + composer recover.
    expect(reconnected.status).toBe("completed");
    expect(["submitting", "streaming"]).not.toContain(reconnected.status);
  });

  it("subscription-opened{taskRunning:false} settles to idle when there's no assistant reply yet", () => {
    // Task started but produced no assistant output before the client missed
    // the completion (e.g. an immediate abort). Nothing to "complete" — go idle.
    const running = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "hi" },
        { type: "task-started", taskId: "t1" },
      ]),
    );
    expect(running.taskRunning).toBe(true);

    const reconnected = chatEventReducer(running, {
      type: "subscription-opened",
      taskRunning: false,
      eventId: -1,
    });
    expect(reconnected.taskRunning).toBe(false);
    expect(reconnected.status).toBe("idle");
  });

  /**
   * The protective counterpart: a `subscription-opened{taskRunning:false}`
   * arriving in the tiny PRE-ACK window after `send()` dispatched its
   * synthetic optimistic `task-started` (negative eventId) must NOT clear the
   * optimistic indicator. The server reports false there only because the
   * real task hasn't started yet; clearing would blink the indicator off then
   * back on when the real `task-started` lands a few ms later.
   */
  it("optimistic task-started then subscription-opened{taskRunning:false} in the pre-ack window does NOT clear", () => {
    // Mirror `send()`: optimistic user-message + task-started, both negative.
    const optimistic = applyEvents(INITIAL_STATE, [
      { type: "user-message", text: "ping", eventId: -1000 },
      { type: "task-started", taskId: "pending-1000", eventId: -1001 },
    ] as ChatEvent[]);
    expect(optimistic.taskRunning).toBe(true);
    expect(optimistic.status).toBe("submitting");
    expect(optimistic.pendingOptimisticTask).toBe(true);

    // A reconnect lands before the server acknowledges the task.
    const midSend = chatEventReducer(optimistic, {
      type: "subscription-opened",
      taskRunning: false,
      eventId: -1002,
    });
    // Still optimistically running — indicator stays up, no blink. Status is
    // a streaming-equivalent (`submitting` or `streaming`), never a terminal
    // one, so `isStreaming` stays true.
    expect(midSend.taskRunning).toBe(true);
    expect(["submitting", "streaming"]).toContain(midSend.status);
    expect(midSend.pendingOptimisticTask).toBe(true);
  });

  /**
   * Once the server's REAL `task-started` (positive eventId) acknowledges the
   * optimistic send, the pending flag is cleared and a subsequent
   * `subscription-opened{taskRunning:false}` becomes authoritative again — so
   * a completion missed AFTER acknowledgement still recovers.
   */
  it("real task-started acknowledges the optimistic send, re-enabling authoritative downgrade", () => {
    const optimistic = applyEvents(INITIAL_STATE, [
      { type: "user-message", text: "ping", eventId: -1000 },
      { type: "task-started", taskId: "pending-1000", eventId: -1001 },
    ] as ChatEvent[]);
    expect(optimistic.pendingOptimisticTask).toBe(true);

    // Server echoes the real lifecycle: user-message echo + real task-started.
    const acked = applyEvents(optimistic, [
      { type: "user-message", text: "ping", eventId: 1 },
      { type: "task-started", taskId: "t-real", eventId: 2 },
      { type: "text-start", id: "p1", eventId: 3 },
      { type: "text-delta", id: "p1", delta: "answer", eventId: 4 },
    ] as ChatEvent[]);
    expect(acked.pendingOptimisticTask).toBe(false);
    expect(acked.taskRunning).toBe(true);

    // Client detaches, misses task-completed, reconnects.
    const reconnected = chatEventReducer(acked, {
      type: "subscription-opened",
      taskRunning: false,
      eventId: -2,
    });
    expect(reconnected.taskRunning).toBe(false);
    expect(reconnected.status).toBe("completed");
  });
});

describe("chatEventReducer — scroll-back pagination (#572)", () => {
  it("history-meta records hasOlder + oldestOffset", () => {
    const state = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "recent" },
        { type: "history-meta", hasOlder: true, oldestOffset: 950 },
      ]),
    );
    expect(state.hasOlder).toBe(true);
    expect(state.oldestOffset).toBe(950);
    // Default before any history-meta: nothing older.
    expect(INITIAL_STATE.hasOlder).toBe(false);
    expect(INITIAL_STATE.oldestOffset).toBeUndefined();
  });

  it("prepend-messages adds older messages to the FRONT and updates the cursor", () => {
    // Current (windowed) state: one recent user turn + history-meta cursor.
    const base = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "newest" },
        { type: "history-meta", hasOlder: true, oldestOffset: 50 },
      ]),
    );
    const firstIdBefore = base.messages[0].id;

    // An older page, folded in isolation and id-namespaced exactly as the hook
    // does, then prepended.
    const older = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "user-message", text: "older-1" },
        { type: "user-message", text: "older-2" },
      ]),
    ).messages.map((m) => ({ ...m, id: `o50-${m.id}` }));

    const next = chatEventReducer(base, {
      type: "prepend-messages",
      messages: older,
      hasOlder: false,
      oldestOffset: 0,
    });

    // Older messages are now at the front, in order, ahead of the existing one.
    expect(next.messages).toHaveLength(3);
    expect(textOf(next.messages[0])).toBe("older-1");
    expect(textOf(next.messages[1])).toBe("older-2");
    expect(textOf(next.messages[2])).toBe("newest");
    // The previously-first message keeps its identity (DOM rows stay stable).
    expect(next.messages[2].id).toBe(firstIdBefore);
    // Cursor advanced to the start of history.
    expect(next.hasOlder).toBe(false);
    expect(next.oldestOffset).toBe(0);
  });

  it("buffers a tool-output whose tool_use isn't loaded yet, then resolves it on tool-input-available", () => {
    // Windowed window replays a tool_result whose tool_use is in an older page:
    // the output arrives with no owner.
    const buffered = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "tool-output-available", toolCallId: "call-1", output: "RESULT", isError: false },
      ]),
    );
    // Nothing rendered yet — the output is parked, not dropped.
    expect(buffered.messages).toHaveLength(0);
    expect(buffered.pendingToolOutputs["call-1"]).toBeTruthy();

    // The owning tool_use arrives (live, or via a later prepend folded as text).
    const resolved = applyEvents(buffered, [
      { type: "text-start", id: "p1", eventId: 10 },
      { type: "text-delta", id: "p1", delta: "thinking", eventId: 11 },
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "Bash",
        input: { command: "ls" },
        eventId: 12,
      },
    ] as ChatEvent[]);

    // The buffer drained and the tool part now carries the output.
    expect(resolved.pendingToolOutputs["call-1"]).toBeUndefined();
    const toolPart = resolved.messages
      .flatMap((m) => m.parts)
      .find((p) => (p as { toolCallId?: string }).toolCallId === "call-1") as
      | { state?: string; output?: unknown }
      | undefined;
    expect(toolPart?.state).toBe("output-available");
    expect(toolPart?.output).toBe("RESULT");
  });

  it("prepend resolves a buffered output whose tool_use the older page introduces", () => {
    // The current window holds only the tool_result (orphan output buffered).
    const windowState = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "tool-output-available", toolCallId: "call-9", output: "OUT", isError: false },
        { type: "history-meta", hasOlder: true, oldestOffset: 10 },
      ]),
    );
    expect(windowState.pendingToolOutputs["call-9"]).toBeTruthy();

    // The older page (folded in isolation) contains the assistant tool_use.
    const olderFold = applyEvents(
      INITIAL_STATE,
      seq([
        { type: "text-start", id: "p9" },
        { type: "text-delta", id: "p9", delta: "calling tool" },
        { type: "tool-input-available", toolCallId: "call-9", toolName: "Bash", input: {} },
      ]),
    );
    const older = olderFold.messages.map((m) => ({ ...m, id: `o10-${m.id}` }));

    const next = chatEventReducer(windowState, {
      type: "prepend-messages",
      messages: older,
      hasOlder: false,
      oldestOffset: 0,
      pendingToolOutputs: olderFold.pendingToolOutputs,
    });

    // The buffered output binds to the just-prepended tool_use.
    expect(next.pendingToolOutputs["call-9"]).toBeUndefined();
    const toolPart = next.messages
      .flatMap((m) => m.parts)
      .find((p) => (p as { toolCallId?: string }).toolCallId === "call-9") as
      | { state?: string; output?: unknown }
      | undefined;
    expect(toolPart?.state).toBe("output-available");
    expect(toolPart?.output).toBe("OUT");
  });
});

/** Concatenated text of a message's text parts. */
function textOf(msg: { parts: Array<unknown> }): string {
  return (msg.parts as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}
