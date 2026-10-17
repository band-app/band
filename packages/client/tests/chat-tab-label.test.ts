import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatTabLabel } from "../src/chat-tab-label.ts";

describe("chat tab label", () => {
  it("prefers a name the user gave the chat", () => {
    assert.equal(chatTabLabel({ name: "Parser fix", summary: "fix the parser" }), "Parser fix");
  });

  it("treats the hub's default name as no name", () => {
    assert.equal(chatTabLabel({ name: "Chat", summary: "fix the parser" }), "fix the parser");
    assert.equal(chatTabLabel({ name: "  ", agentLabel: "Claude Code" }), "Claude Code");
  });

  it("falls back to the agent label, the agent id, then Chat", () => {
    assert.equal(chatTabLabel({ agentLabel: "Codex", agentId: "codex" }), "Codex");
    assert.equal(chatTabLabel({ agentId: "codex" }), "codex");
    assert.equal(chatTabLabel({}), "Chat");
  });
});
