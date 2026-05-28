/**
 * Tests for `jsonlMessageToEvents` — the JSONL-replay translation seam
 * of `apps/web/src/api/chat-events.ts`.
 *
 * This is the same shape of test as `chat-event-reducer.test.ts`: a
 * pure function on a public module boundary, driven with hand-crafted
 * inputs that mirror what the real agent SDK produces. No I/O, no
 * server boot — the production HTTP path can't easily exercise this
 * code without coupling the test to the underlying SDK's on-disk JSONL
 * format (the fake-agent stub doesn't write a Claude-shaped JSONL
 * back to disk, and pre-seeding one would require maintaining a
 * mirror of the SDK's internal schema).
 *
 * Regression coverage for issue #509 "Case B": tool-result blocks on
 * synthetic user-role messages were silently dropped during JSONL
 * backfill, leaving every reloaded session's tool calls stuck in
 * `input-available` (orange pulse forever) AND surfacing as empty
 * user bubbles between assistant turns.
 */

import { describe, expect, it } from "vitest";
import {
  type JsonlMessage,
  jsonlMessageToEvents,
  stripFileSharingHint,
} from "../src/server/services/jsonl-message-to-events";

describe("jsonlMessageToEvents", () => {
  describe("user-role messages", () => {
    it("emits a single user-message for a text-only user input", () => {
      const msg: JsonlMessage = {
        role: "user",
        id: "u-1",
        content: [{ type: "text", text: "hello world" }],
      };
      const events = jsonlMessageToEvents(msg, 100);
      expect(events).toEqual([{ type: "user-message", text: "hello world", eventId: 100 }]);
    });

    /**
     * Regression for issue #509 Case B (Mode 1): the synthetic
     * tool-result user frame must produce ONE `tool-output-available`
     * event per `tool_result` block, NOT a `user-message`. The legacy
     * code returned early on the user-role branch after only
     * inspecting text parts, so every tool result on a reloaded
     * Claude session was lost AND a blank user bubble surfaced where
     * the synthetic frame lived.
     */
    it("emits tool-output-available for a pure tool-result user frame and NO user-message", () => {
      const msg: JsonlMessage = {
        role: "user",
        id: "u-tool-result-1",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc-1",
            output: "file contents",
            isError: false,
          },
        ],
      };
      const events = jsonlMessageToEvents(msg, 50);
      expect(events).toEqual([
        {
          type: "tool-output-available",
          toolCallId: "tc-1",
          output: "file contents",
          isError: false,
          eventId: 50,
        },
      ]);
      // Crucial: no empty user-message leaks through — that was the
      // visible "blank user bubble" half of the bug.
      expect(events.find((e) => e.type === "user-message")).toBeUndefined();
    });

    it("preserves isError=true on tool-output-available", () => {
      const msg: JsonlMessage = {
        role: "user",
        id: "u-tool-error-1",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc-err",
            output: "ENOENT: no such file",
            isError: true,
          },
        ],
      };
      const events = jsonlMessageToEvents(msg, 1);
      expect(events).toHaveLength(1);
      const out = events[0] as Extract<(typeof events)[number], { type: "tool-output-available" }>;
      expect(out.type).toBe("tool-output-available");
      expect(out.isError).toBe(true);
      expect(out.output).toBe("ENOENT: no such file");
    });

    it("emits multiple tool-output-available events for a user frame carrying multiple tool_result blocks", () => {
      // Defensive: rare in practice, but Claude can batch parallel
      // tool results into a single synthetic user frame.
      const msg: JsonlMessage = {
        role: "user",
        id: "u-multi",
        content: [
          { type: "tool_result", toolCallId: "tc-a", output: "out-a", isError: false },
          { type: "tool_result", toolCallId: "tc-b", output: "out-b", isError: false },
        ],
      };
      const events = jsonlMessageToEvents(msg, 10);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "tool-output-available", toolCallId: "tc-a" });
      expect(events[1]).toMatchObject({ type: "tool-output-available", toolCallId: "tc-b" });
      // Ids advance monotonically from startId.
      expect((events[0] as { eventId: number }).eventId).toBe(10);
      expect((events[1] as { eventId: number }).eventId).toBe(11);
    });

    it("emits both tool-output-available and user-message when a frame mixes tool_result with text", () => {
      // Defensive case: unusual in Claude's wire format but the function
      // shouldn't drop either kind of event. Tool results emit first so
      // they resolve their owning assistant message before any
      // currentAssistantId reset implied by the new user-message.
      const msg: JsonlMessage = {
        role: "user",
        id: "u-mixed",
        content: [
          { type: "tool_result", toolCallId: "tc-mix", output: "tool-out", isError: false },
          { type: "text", text: "and here is the next thing" },
        ],
      };
      const events = jsonlMessageToEvents(msg, 0);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "tool-output-available", toolCallId: "tc-mix" });
      expect(events[1]).toMatchObject({ type: "user-message", text: "and here is the next thing" });
    });

    it("strips the [File sharing: …] hint from the user-message text", () => {
      // Regression for the file-sharing-hint suffix `task-service`
      // appends to first-turn prompts. JSONL persists the augmented
      // prompt; replay must strip it so the bubble shows what the
      // user actually typed.
      const msg: JsonlMessage = {
        role: "user",
        id: "u-hint",
        content: [
          {
            type: "text",
            text: "look at this\n\n[File sharing: please use the attached files]",
          },
        ],
      };
      const events = jsonlMessageToEvents(msg, 0);
      expect(events).toHaveLength(1);
      expect((events[0] as { text: string }).text).toBe("look at this");
    });

    it("aggregates multiple text blocks into a single user-message", () => {
      // Defensive: Claude can split user prompts across multiple text
      // blocks. The bubble should still render as one message, not
      // multiple — matches the live broadcast behaviour.
      const msg: JsonlMessage = {
        role: "user",
        id: "u-multi-text",
        content: [
          { type: "text", text: "part 1 " },
          { type: "text", text: "part 2" },
        ],
      };
      const events = jsonlMessageToEvents(msg, 0);
      expect(events).toHaveLength(1);
      expect((events[0] as { text: string }).text).toBe("part 1 part 2");
    });
  });

  describe("assistant-role messages", () => {
    it("translates text → text-start / text-delta / text-end", () => {
      const msg: JsonlMessage = {
        role: "assistant",
        id: "a-1",
        content: [{ type: "text", text: "hello back" }],
      };
      const events = jsonlMessageToEvents(msg, 200);
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "text-start", id: "a-1-text-200" });
      expect(events[1]).toMatchObject({
        type: "text-delta",
        id: "a-1-text-200",
        delta: "hello back",
      });
      expect(events[2]).toMatchObject({ type: "text-end", id: "a-1-text-200" });
    });

    it("translates tool_use → tool-input-available", () => {
      const msg: JsonlMessage = {
        role: "assistant",
        id: "a-tool-1",
        content: [
          {
            type: "tool_use",
            toolCallId: "tc-bash",
            toolName: "Bash",
            displayTitle: "Bash(ls)",
            input: { command: "ls" },
          },
        ],
      };
      const events = jsonlMessageToEvents(msg, 0);
      expect(events).toEqual([
        {
          type: "tool-input-available",
          toolCallId: "tc-bash",
          toolName: "Bash",
          displayTitle: "Bash(ls)",
          input: { command: "ls" },
          eventId: 0,
        },
      ]);
    });

    it("translates tool_result on assistant messages too (unusual but supported)", () => {
      // Subagents and the OpenCode adapter can put tool_result on
      // assistant frames. The function must handle both placements
      // identically so the routing fix in `chat-event-reducer.ts` has
      // the same `tool-output-available` to resolve regardless of
      // which role the result lived on.
      const msg: JsonlMessage = {
        role: "assistant",
        id: "a-tool-res",
        content: [
          {
            type: "tool_result",
            toolCallId: "tc-subagent",
            output: "sub-output",
            isError: false,
          },
        ],
      };
      const events = jsonlMessageToEvents(msg, 0);
      expect(events).toEqual([
        {
          type: "tool-output-available",
          toolCallId: "tc-subagent",
          output: "sub-output",
          isError: false,
          eventId: 0,
        },
      ]);
    });

    it("emits text + tool_use in order for a turn that mixes them", () => {
      const msg: JsonlMessage = {
        role: "assistant",
        id: "a-mixed",
        content: [
          { type: "text", text: "Let me check that." },
          {
            type: "tool_use",
            toolCallId: "tc-read",
            toolName: "Read",
            input: { file_path: "x.md" },
          },
        ],
      };
      const events = jsonlMessageToEvents(msg, 0);
      // 3 text events + 1 tool-input-available
      expect(events).toHaveLength(4);
      expect((events[0] as { type: string }).type).toBe("text-start");
      expect((events[1] as { type: string }).type).toBe("text-delta");
      expect((events[2] as { type: string }).type).toBe("text-end");
      expect((events[3] as { type: string }).type).toBe("tool-input-available");
    });
  });

  describe("event-id assignment", () => {
    it("starts numbering at startId and increments by 1 per emitted event", () => {
      const msg: JsonlMessage = {
        role: "assistant",
        id: "a-counter",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", toolCallId: "tc-z", toolName: "Z", input: {} },
        ],
      };
      const events = jsonlMessageToEvents(msg, 500);
      const ids = events.map((e) => (e as { eventId: number }).eventId);
      expect(ids).toEqual([500, 501, 502, 503]);
    });
  });
});

describe("stripFileSharingHint", () => {
  it("removes the trailing [File sharing: …] suffix", () => {
    expect(
      stripFileSharingHint("real prompt\n\n[File sharing: please use /tmp/uploads/x.png]"),
    ).toBe("real prompt");
  });

  it("leaves text without the hint unchanged", () => {
    expect(stripFileSharingHint("just a normal prompt")).toBe("just a normal prompt");
  });

  it("only strips a hint at the END of the text", () => {
    // Defensive: a literal `[File sharing:` in the middle of a
    // prompt's body — e.g. the user explaining the hint mechanism to
    // the agent — must survive.
    const text =
      "I want to test [File sharing: foo] handling.\n\nHere's an example you can ignore.";
    expect(stripFileSharingHint(text)).toBe(text);
  });
});
