import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldEvents, INITIAL_TRANSCRIPT } from "@band-app/client/transcript";
import type { ChatEvent } from "@band-app/shared/chat-events";
import {
  pendingRequest,
  permissionInput,
  permissionTexts,
  requestText,
} from "../src/lib/chat/pending-request.ts";

let id = 0;
const ev = (e: Record<string, unknown>): ChatEvent =>
  ({ eventId: ++id, ...e }) as unknown as ChatEvent;
const permission = (requestId: string): ChatEvent =>
  ev({
    type: "permission",
    requestId,
    request: {
      sessionId: "s",
      toolCall: {
        toolCallId: "t",
        title: "Run tests",
        rawInput: { command: "pnpm test", description: "Run the tests", empty: "" },
        content: [{ type: "content", content: { type: "text", text: "Plan: run them" } }],
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    },
  });

describe("pendingRequest", () => {
  const base = [ev({ type: "prompt", text: "go" }), ev({ type: "turn-started" })];

  it("finds the open permission request of the last message", () => {
    const state = foldEvents(INITIAL_TRANSCRIPT, [...base, permission("p1")]);
    const entry = pendingRequest(state.messages);
    assert.equal(entry?.kind, "permission");
    assert.equal(entry?.id, "p1");
  });

  it("has none once the request is answered", () => {
    const state = foldEvents(INITIAL_TRANSCRIPT, [
      ...base,
      permission("p1"),
      ev({ type: "request-resolved", requestId: "p1", answer: "allow" }),
    ]);
    assert.equal(pendingRequest(state.messages), undefined);
  });

  it("has none in a chat that ends with a user message", () => {
    const state = foldEvents(INITIAL_TRANSCRIPT, [ev({ type: "prompt", text: "hi" })]);
    assert.equal(pendingRequest(state.messages), undefined);
  });
});

describe("permission details", () => {
  const state = foldEvents(INITIAL_TRANSCRIPT, [
    ev({ type: "prompt", text: "go" }),
    ev({ type: "turn-started" }),
    permission("p2"),
  ]);
  const entry = pendingRequest(state.messages);

  it("lists the tool input without empty values, and the attached text", () => {
    assert.ok(entry?.kind === "permission");
    assert.deepEqual(permissionInput(entry), ["command: pnpm test", "description: Run the tests"]);
    assert.deepEqual(permissionTexts(entry), ["Plan: run them"]);
  });
});

describe("requestText", () => {
  it("names the tool for a permission request", () => {
    const state = foldEvents(INITIAL_TRANSCRIPT, [
      ev({ type: "prompt", text: "go" }),
      ev({ type: "turn-started" }),
      permission("p9"),
    ]);
    const entry = pendingRequest(state.messages);
    assert.ok(entry);
    assert.equal(requestText(entry), "Run tests");
  });
});
