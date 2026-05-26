/**
 * Translate persisted session messages (from `agent.getSessionMessages`)
 * into the same `ChatEvent` shapes the live SSE stream emits.
 *
 * This is the JSONL-replay seam of the chat-events endpoint: when a
 * client cold-subscribes to a chat whose buffer has rotated past the
 * cursor (or never existed — e.g. after a server restart), the handler
 * pages the session in from disk via `agent.getSessionMessages` and
 * feeds each message through this function. The output is fed back into
 * the same `chatEventReducer` the live tail drives, so the reducer
 * doesn't need a special-case "this came from JSONL" path.
 *
 * Lives in its own module so it can be exercised by a pure unit test
 * — the e2e/HTTP path can't easily exercise it without coupling the
 * test to the underlying agent SDK's JSONL format. The reducer follows
 * the same pattern (`chat-event-reducer.ts`).
 */

import type { ChatEvent } from "./chat-events";

/** Minimal shape of a persisted message we accept — matches
 *  `SessionMessageItem` from `@band-app/coding-agent` but kept local so
 *  this module has no cross-package import. The runtime shape is
 *  identical. */
export interface JsonlMessage {
  role: "user" | "assistant";
  id: string;
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        toolCallId: string;
        toolName: string;
        displayTitle?: string;
        input: unknown;
      }
    | { type: "tool_result"; toolCallId: string; output: string; isError: boolean }
  >;
}

/**
 * Strip the agent-only `[File sharing: …]` suffix that `task-runner`
 * appends to the FIRST user prompt of a new session (see
 * `fileSharingHint` in `apps/web/src/lib/task-runner.ts`). The hint is
 * meant for the agent, not the user — and the live `user-message`
 * broadcast already strips it by using `task.prompt` (the clean
 * original) instead of `task.agentPrompt`. On JSONL replay we read
 * whatever the agent persisted, which DOES include the hint suffix —
 * so we strip it here too.
 */
export function stripFileSharingHint(text: string): string {
  return text.replace(/\n\n\[File sharing:[\s\S]*?\]\s*$/, "");
}

/**
 * Map a single `JsonlMessage` to the `ChatEvent` sequence the live
 * stream would have produced for the same agent activity. `startId` is
 * the synthetic event id to assign to the first emitted event; the
 * function returns events with monotonically increasing ids from
 * `startId`, and the caller advances its own counter by the length of
 * the returned array.
 *
 * Behaviour notes:
 *
 *   - **User-role messages** can be one of two distinct things in the
 *     Claude / Codex / etc. wire format:
 *       1. A *real* user input (has at least one `text` block).
 *       2. A *synthetic* tool-result frame the agent emits to feed a
 *          tool's output back to the model (has only `tool_result`
 *          blocks).
 *
 *     For (1) we emit a single `user-message` aggregating all text
 *     parts. For (2) we emit one `tool-output-available` per
 *     `tool_result` block and NO `user-message` — emitting an empty
 *     `user-message` would surface as a blank user bubble in the UI,
 *     and dropping the `tool_result` events would leave every reloaded
 *     session with its tool calls stuck in `input-available` forever
 *     (issue #509 "Case B"). A frame with both — unusual but
 *     defensively supported — emits both kinds of event.
 *
 *   - **Assistant-role messages** translate text → `text-start` /
 *     `text-delta` / `text-end`, `tool_use` → `tool-input-available`,
 *     and `tool_result` (rare but possible) → `tool-output-available`.
 */
export function jsonlMessageToEvents(msg: JsonlMessage, startId: number): ChatEvent[] {
  const events: ChatEvent[] = [];
  let id = startId;

  if (msg.role === "user") {
    let textBuf = "";
    let hasText = false;
    for (const part of msg.content) {
      if (part.type === "text") {
        hasText = true;
        textBuf += part.text;
      } else if (part.type === "tool_result") {
        events.push({
          type: "tool-output-available",
          toolCallId: part.toolCallId,
          output: part.output,
          isError: part.isError,
          eventId: id++,
        });
      }
    }
    if (hasText) {
      events.push({
        type: "user-message",
        text: stripFileSharingHint(textBuf),
        eventId: id++,
      });
    }
    return events;
  }

  // Assistant message → translate parts into the live-stream event sequence.
  for (const part of msg.content) {
    if (part.type === "text") {
      const textPartId = `${msg.id}-text-${id}`;
      events.push({ type: "text-start", id: textPartId, eventId: id++ });
      events.push({ type: "text-delta", id: textPartId, delta: part.text, eventId: id++ });
      events.push({ type: "text-end", id: textPartId, eventId: id++ });
    } else if (part.type === "tool_use") {
      events.push({
        type: "tool-input-available",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        displayTitle: part.displayTitle,
        input: part.input,
        eventId: id++,
      });
    } else if (part.type === "tool_result") {
      events.push({
        type: "tool-output-available",
        toolCallId: part.toolCallId,
        output: part.output,
        isError: part.isError,
        eventId: id++,
      });
    }
  }
  return events;
}
