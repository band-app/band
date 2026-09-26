/**
 * Transcript reducer tests (issue #648): fold fixed lists of the chat events
 * the server streams (`src/shared/chat-events.ts`) through
 * `transcriptReducer` / `foldEvents` and assert on the resulting transcript.
 * Pure, no I/O, no mocks: the reducer is a pure function, so the edge cases
 * (orphan tool updates, revision resets, dedupe by id) are cheaper and more
 * exhaustive here than through the browser. The user-visible paths are also
 * covered end to end by the chat e2e specs.
 */

import { describe, expect, it } from "vitest";
import {
  type ChatMessage,
  foldEvents,
  INITIAL_TRANSCRIPT,
  type TranscriptState,
  transcriptReducer,
} from "../src/components/chat/transcript";
import type {
  ChatEvent,
  ChatEventPayload,
  SessionState,
  SessionUpdate,
} from "../src/shared/chat-events";

/** Gives each payload a logged (positive, increasing) event id. */
function logged(events: ChatEventPayload[], firstId = 1): ChatEvent[] {
  return events.map((e, i) => ({ ...e, eventId: firstId + i }) as ChatEvent);
}

const update = (u: SessionUpdate): ChatEventPayload => ({ type: "update", update: u });

const say = (text: string, messageId?: string): ChatEventPayload =>
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId ? { messageId } : {}),
  });

const think = (text: string): ChatEventPayload =>
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });

const opened = (
  over: Partial<Extract<ChatEvent, { type: "subscription-opened" }>> = {},
): ChatEvent => ({
  type: "subscription-opened",
  revision: 1,
  taskRunning: false,
  reset: false,
  eventId: -1,
  ...over,
});

const SESSION: SessionState = {
  source: "live",
  configOptions: [],
  modes: null,
  models: null,
  commands: [],
  usage: null,
  costUsd: null,
  title: null,
};

function assistant(
  state: TranscriptState,
  index = -1,
): Extract<ChatMessage, { role: "assistant" }> {
  const message = state.messages.at(index);
  if (message?.role !== "assistant") {
    throw new Error(`message ${index} is ${message?.role ?? "missing"}, not assistant`);
  }
  return message;
}

describe("transcriptReducer — agent text", () => {
  it("merges consecutive chunks of one messageId into one text entry", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([say("Hel", "m1"), say("lo ", "m1"), say("world", "m1")]),
    );
    expect(state.messages).toHaveLength(1);
    expect(assistant(state).entries).toEqual([
      { kind: "text", id: "text1", text: "Hello world", messageId: "m1" },
    ]);
    expect(state.lastEventId).toBe(3);
  });

  it("starts a new text entry when the messageId changes, and keeps thoughts apart", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([think("pondering"), say("first", "m1"), say("second", "m2"), say(" part", "m2")]),
    );
    expect(state.messages).toHaveLength(1);
    expect(assistant(state).entries).toEqual([
      { kind: "thought", id: "thought1", text: "pondering", messageId: null },
      { kind: "text", id: "text2", text: "first", messageId: "m1" },
      { kind: "text", id: "text3", text: "second part", messageId: "m2" },
    ]);
  });

  it("builds a replayed user message from user_message_chunks", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "from " } }),
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "load" } }),
        say("reply"),
      ]),
    );
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[0]).toEqual({
      role: "user",
      id: "u1",
      text: "from load",
      replayed: true,
    });
  });
});

describe("transcriptReducer — tool calls and plan", () => {
  it("merges a tool_call_update into its tool_call entry", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read README.md",
          kind: "read",
          status: "pending",
          rawInput: { path: "README.md" },
        }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "# Title" } }],
          rawOutput: "# Title",
        }),
      ]),
    );
    expect(assistant(state).entries).toEqual([
      {
        kind: "tool",
        id: "t1",
        title: "Read README.md",
        name: undefined,
        toolKind: "read",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "# Title" } }],
        locations: [],
        rawInput: { path: "README.md" },
        rawOutput: "# Title",
      },
    ]);
  });

  it("shows a tool_call_update whose tool_call fell outside the loaded window", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "orphan",
          title: "Run tests",
          status: "completed",
        }),
      ]),
    );
    expect(assistant(state).entries).toMatchObject([
      { kind: "tool", id: "orphan", title: "Run tests", status: "completed" },
    ]);
  });

  it("replaces the plan with each plan update", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        update({
          sessionUpdate: "plan",
          entries: [{ content: "Write test", priority: "high", status: "pending" }],
        }),
        update({
          sessionUpdate: "plan",
          entries: [
            { content: "Write test", priority: "high", status: "completed" },
            { content: "Fix bug", priority: "medium", status: "in_progress" },
          ],
        }),
      ]),
    );
    expect(state.plan).toEqual([
      { content: "Write test", priority: "high", status: "completed" },
      { content: "Fix bug", priority: "medium", status: "in_progress" },
    ]);
    // The plan lives beside the transcript, not in it.
    expect(state.messages).toEqual([]);
  });
});

describe("transcriptReducer — permission and elicitation requests", () => {
  const permission: ChatEventPayload = {
    type: "permission",
    requestId: "req-1",
    request: {
      sessionId: "s1",
      toolCall: { toolCallId: "edit-1", title: "Edit README.md" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  };

  it("shows a permission request and records its answer from request-resolved", () => {
    const waiting = foldEvents(INITIAL_TRANSCRIPT, logged([permission]));
    expect(assistant(waiting).entries).toEqual([
      {
        kind: "permission",
        id: "req-1",
        request: permission.type === "permission" && permission.request,
      },
    ]);

    const answered = foldEvents(
      waiting,
      logged([{ type: "request-resolved", requestId: "req-1", answer: "allow" }], 2),
    );
    expect(assistant(answered).entries).toMatchObject([
      { kind: "permission", id: "req-1", answer: "allow" },
    ]);
  });

  it("marks an unanswered request cancelled when the turn ends", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        { type: "turn-started", taskId: "t" },
        {
          type: "elicitation",
          requestId: "req-2",
          request: {
            mode: "form",
            sessionId: "s1",
            message: "Which database?",
            requestedSchema: { type: "object", properties: {} },
          },
        },
        { type: "turn-ended", taskId: "t", stopReason: "end_turn" },
      ]),
    );
    expect(assistant(state).entries).toMatchObject([
      { kind: "elicitation", id: "req-2", answer: "cancelled" },
    ]);
  });
});

describe("transcriptReducer — send and turn lifecycle", () => {
  it("confirms an optimistic send in place when the prompt event arrives", () => {
    const sent = transcriptReducer(INITIAL_TRANSCRIPT, {
      type: "local-send",
      id: "local-1",
      text: "hello",
    });
    expect(sent.messages).toEqual([{ role: "user", id: "local-1", text: "hello", pending: true }]);
    expect(sent).toMatchObject({ status: "submitting", taskRunning: true, pendingSend: true });

    const confirmed = foldEvents(
      sent,
      logged([
        { type: "prompt", taskId: "t", text: "hello" },
        { type: "turn-started", taskId: "t" },
      ]),
    );
    // Same bubble (same id), no longer pending, and no second user message.
    expect(confirmed.messages).toEqual([
      { role: "user", id: "local-1", text: "hello", files: undefined, pending: false },
    ]);
    expect(confirmed).toMatchObject({ status: "streaming", taskRunning: true, pendingSend: false });
  });

  it("adds a user message for a prompt it didn't send", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        {
          type: "prompt",
          taskId: "t",
          text: "from the CLI",
          files: [{ mediaType: "text/plain", url: "/api/uploads/a.txt", filename: "a.txt" }],
        },
      ]),
    );
    expect(state.messages).toEqual([
      {
        role: "user",
        id: "u1",
        text: "from the CLI",
        files: [{ mediaType: "text/plain", url: "/api/uploads/a.txt", filename: "a.txt" }],
      },
    ]);
  });

  it("settles a finished turn: idle, cost taken from usage, no notice for end_turn", () => {
    const state = foldEvents(
      { ...INITIAL_TRANSCRIPT, session: SESSION },
      logged([
        { type: "prompt", taskId: "t", text: "go" },
        { type: "turn-started", taskId: "t" },
        say("done"),
        {
          type: "turn-ended",
          taskId: "t",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25 },
        },
      ]),
    );
    expect(state).toMatchObject({ status: "idle", taskRunning: false, errorMessage: undefined });
    expect(state.session?.costUsd).toBe(0.25);
    expect(assistant(state).entries.map((e) => e.kind)).toEqual(["text"]);
  });

  it("a cancelled turn fails running tools and adds a Stopped notice", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        { type: "turn-started", taskId: "t" },
        update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Run",
          status: "in_progress",
        }),
        { type: "turn-ended", taskId: "t", stopReason: "cancelled" },
      ]),
    );
    expect(assistant(state).entries).toMatchObject([
      { kind: "tool", id: "t1", status: "failed" },
      { kind: "notice", id: "n3", level: "info", text: "Stopped." },
    ]);
    expect(state.status).toBe("idle");
  });

  it("a failed turn shows the error as a notice and puts the chat in error", () => {
    const state = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([
        { type: "turn-started", taskId: "t" },
        { type: "turn-ended", taskId: "t", error: "agent exited with code 3" },
      ]),
    );
    expect(assistant(state).entries).toEqual([
      { kind: "notice", id: "n2", level: "error", text: "agent exited with code 3" },
    ]);
    expect(state).toMatchObject({
      status: "error",
      taskRunning: false,
      errorMessage: "agent exited with code 3",
    });
  });
});

describe("transcriptReducer — subscription and cursor", () => {
  it("subscription-opened with reset drops the transcript but keeps the queue", () => {
    const before = foldEvents(
      { ...INITIAL_TRANSCRIPT, queue: [{ id: "q1", text: "later" }] },
      logged([{ type: "prompt", taskId: "t", text: "old" }, say("old reply")]),
    );
    const state = transcriptReducer(before, opened({ reset: true, revision: 2, sessionId: "s2" }));
    expect(state.messages).toEqual([]);
    expect(state.lastEventId).toBeUndefined();
    expect(state.queue).toEqual([{ id: "q1", text: "later" }]);
    expect(state).toMatchObject({ revision: 2, sessionId: "s2" });
  });

  it("subscription-opened without reset keeps the transcript and takes the server's run state", () => {
    const before = foldEvents(INITIAL_TRANSCRIPT, logged([say("kept")]));
    const state = transcriptReducer(before, opened({ taskRunning: true, sessionId: "s1" }));
    expect(state.messages).toBe(before.messages);
    expect(state).toMatchObject({ taskRunning: true, status: "streaming", sessionId: "s1" });
  });

  it("drops logged events at or before lastEventId (a replay it already has)", () => {
    const first = foldEvents(INITIAL_TRANSCRIPT, logged([say("one ", "m"), say("two", "m")]));
    // A reconnect replays event 2 again, then event 3 is new.
    const again = foldEvents(first, [
      { ...say("two", "m"), eventId: 2 } as ChatEvent,
      { ...say(" three", "m"), eventId: 3 } as ChatEvent,
    ]);
    expect(assistant(again).entries).toEqual([
      { kind: "text", id: "text1", text: "one two three", messageId: "m" },
    ]);
    expect(again.lastEventId).toBe(3);
    // Replaying only old events leaves the state untouched.
    expect(transcriptReducer(again, { ...say("one ", "m"), eventId: 1 } as ChatEvent)).toBe(again);
  });

  it("negative (transient) ids apply without moving the cursor", () => {
    const state = foldEvents(INITIAL_TRANSCRIPT, logged([say("hi")]));
    const next = transcriptReducer(state, {
      type: "notice",
      level: "error",
      text: "agent failed to start",
      eventId: -1_000_000_000,
    });
    expect(next.lastEventId).toBe(1);
    expect(assistant(next).entries.at(-1)).toEqual({
      kind: "notice",
      id: "n-1000000000",
      level: "error",
      text: "agent failed to start",
    });
  });

  it("session-state and session-attached feed the session settings", () => {
    const withState = transcriptReducer(INITIAL_TRANSCRIPT, {
      type: "session-state",
      state: SESSION,
      eventId: -2,
    });
    const attached = foldEvents(
      withState,
      logged([
        {
          type: "session-attached",
          sessionId: "s1",
          how: "new",
          revision: 1,
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "stub-small",
              options: [{ value: "stub-small", name: "Stub Small" }],
            },
          ],
          modes: null,
          models: null,
        },
        update({
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "review", description: "Review" }],
        }),
        update({ sessionUpdate: "session_info_update", title: "Fix the bug" }),
      ]),
    );
    expect(attached.sessionId).toBe("s1");
    // The client adopts the log revision, so its next reconnect gap-fills.
    expect(attached.revision).toBe(1);
    expect(attached.session).toMatchObject({
      source: "live",
      commands: [{ name: "review", description: "Review" }],
      title: "Fix the bug",
      configOptions: [{ id: "model", currentValue: "stub-small" }],
    });
  });

  it("history-meta and local-prepend page in older history", () => {
    const state = foldEvents(INITIAL_TRANSCRIPT, [
      { type: "history-meta", hasOlder: true, oldestEventId: 40, eventId: -3 },
      ...logged([say("recent")], 40),
    ]);
    expect(state).toMatchObject({ hasOlder: true, oldestEventId: 40 });

    const older = foldEvents(
      INITIAL_TRANSCRIPT,
      logged([{ type: "prompt", taskId: "t", text: "old" }]),
    );
    const paged = transcriptReducer(state, {
      type: "local-prepend",
      messages: older.messages,
      hasOlder: false,
      oldestEventId: 1,
    });
    expect(paged.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(paged).toMatchObject({ hasOlder: false, oldestEventId: 1 });
  });
});
