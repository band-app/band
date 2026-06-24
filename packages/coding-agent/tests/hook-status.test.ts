/**
 * Tests for the agent hook → workspace status dispatcher
 * (`packages/coding-agent/src/hook-status.ts`) and the Claude Code adapter's
 * mapper it dispatches to.
 *
 * Run with the package's standard `pnpm test` setup (node:test + the loader
 * that redirects optional adapter SDK imports to local mocks).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapHookPayloadToStatus } from "../src/hook-status.ts";

describe("mapHookPayloadToStatus — claude-code", () => {
  const map = (payload: Record<string, unknown>) => mapHookPayloadToStatus("claude-code", payload);

  it("maps Stop → needs_attention (agent finished its turn)", async () => {
    assert.equal(await map({ hook_event_name: "Stop" }), "needs_attention");
  });

  it("maps PermissionRequest → needs_attention (blocked on approval)", async () => {
    assert.equal(
      await map({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
      "needs_attention",
    );
  });

  it("maps PreToolUse + ExitPlanMode → needs_attention", async () => {
    assert.equal(
      await map({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" }),
      "needs_attention",
    );
  });

  it("maps PreToolUse + AskUserQuestion → needs_attention", async () => {
    assert.equal(
      await map({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
      "needs_attention",
    );
  });

  it("maps PreToolUse + regular tool → working", async () => {
    assert.equal(await map({ hook_event_name: "PreToolUse", tool_name: "Read" }), "working");
  });

  it("maps PostToolUse → working", async () => {
    assert.equal(await map({ hook_event_name: "PostToolUse", tool_name: "Read" }), "working");
  });

  it("maps UserPromptSubmit → working", async () => {
    assert.equal(await map({ hook_event_name: "UserPromptSubmit" }), "working");
  });

  it("defaults to working for an empty/unknown payload", async () => {
    assert.equal(await map({}), "working");
  });
});

describe("mapHookPayloadToStatus — unknown agent type", () => {
  it("defaults to working (agent has no hook integration yet)", async () => {
    assert.equal(await mapHookPayloadToStatus("codex", { hook_event_name: "Stop" }), "working");
  });
});
