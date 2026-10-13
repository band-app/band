/**
 * Tests for the agent hook → worktree status dispatcher
 * (`packages/coding-agent/src/hook-status.ts`) and the Claude Code mapper it
 * dispatches to.
 *
 * Run with the package's standard `pnpm test` setup (node:test).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldSubagents, mapHookPayloadToStatus, type SubagentHold } from "../src/hook-status.ts";

describe("mapHookPayloadToStatus — claude-code", () => {
  const map = (payload: Record<string, unknown>) => mapHookPayloadToStatus("claude-code", payload);

  it("maps Stop → done", async () => {
    assert.equal(await map({ hook_event_name: "Stop" }), "done");
  });

  it("maps Stop with an empty session_crons and background_tasks → done", async () => {
    assert.equal(
      await map({ hook_event_name: "Stop", session_crons: [], background_tasks: [] }),
      "done",
    );
  });

  it("maps Stop with a non-empty session_crons → monitoring", async () => {
    assert.equal(
      await map({ hook_event_name: "Stop", session_crons: [{ id: "c1" }] }),
      "monitoring",
    );
  });

  it("maps Stop with a running background task → monitoring", async () => {
    assert.equal(
      await map({
        hook_event_name: "Stop",
        background_tasks: [{ id: "t1", type: "bash", status: "running" }],
      }),
      "monitoring",
    );
  });

  it("maps Stop with only finished or teammate background tasks → done", async () => {
    assert.equal(
      await map({
        hook_event_name: "Stop",
        background_tasks: [
          { id: "t1", type: "bash", status: "completed" },
          { id: "t2", type: "teammate", status: "running" },
        ],
      }),
      "done",
    );
  });

  it("maps StopFailure → failed", async () => {
    assert.equal(await map({ hook_event_name: "StopFailure" }), "failed");
  });

  // A terminal session is not auto-approved: any permission request waits on the user.
  it("maps PermissionRequest for any tool → question", async () => {
    for (const tool_name of ["Bash", "Write", "Edit", "AskUserQuestion", "ExitPlanMode"]) {
      assert.equal(await map({ hook_event_name: "PermissionRequest", tool_name }), "question");
    }
  });

  it("maps PreToolUse + AskUserQuestion or ExitPlanMode → question", async () => {
    for (const tool_name of ["AskUserQuestion", "ExitPlanMode"]) {
      assert.equal(await map({ hook_event_name: "PreToolUse", tool_name }), "question");
    }
  });

  it("maps PreToolUse for a regular tool → working", async () => {
    assert.equal(await map({ hook_event_name: "PreToolUse", tool_name: "Read" }), "working");
    assert.equal(await map({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "working");
  });

  it("maps UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStart and SubagentStop → working", async () => {
    for (const hook_event_name of [
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
    ]) {
      assert.equal(await map({ hook_event_name }), "working", hook_event_name);
    }
  });

  it("maps a manual PostCompact → done and an automatic one → working", async () => {
    assert.equal(await map({ hook_event_name: "PostCompact", trigger: "manual" }), "done");
    assert.equal(await map({ hook_event_name: "PostCompact", trigger: "auto" }), "working");
  });

  it("defaults to working for an empty or unknown payload", async () => {
    assert.equal(await map({}), "working");
    assert.equal(await map({ hook_event_name: "SomethingNew" }), "working");
  });
});

describe("mapHookPayloadToStatus — unknown agent type", () => {
  it("defaults to working (agent has no hook integration yet)", async () => {
    assert.equal(await mapHookPayloadToStatus("codex", { hook_event_name: "Stop" }), "working");
  });
});

describe("foldSubagents", () => {
  const fresh = (): SubagentHold => ({ running: new Set(), deferred: null });

  it("passes the main turn's Stop through while no subagent runs", () => {
    assert.equal(foldSubagents(fresh(), { hook_event_name: "Stop" }, "done"), "done");
  });

  it("keeps working after Stop while a subagent runs, then settles on the last SubagentStop", () => {
    const hold = fresh();
    foldSubagents(hold, { hook_event_name: "SubagentStart", agent_id: "a" }, "working");
    foldSubagents(hold, { hook_event_name: "SubagentStart", agent_id: "b" }, "working");
    assert.equal(foldSubagents(hold, { hook_event_name: "Stop" }, "monitoring"), "working");
    assert.equal(
      foldSubagents(hold, { hook_event_name: "SubagentStop", agent_id: "a" }, "working"),
      "working",
    );
    assert.equal(
      foldSubagents(hold, { hook_event_name: "SubagentStop", agent_id: "b" }, "working"),
      "monitoring",
    );
  });

  it("does not let a subagent's own Stop end the main turn's work", () => {
    const hold = fresh();
    foldSubagents(hold, { hook_event_name: "SubagentStart", agent_id: "a" }, "working");
    assert.equal(foldSubagents(hold, { hook_event_name: "Stop", agent_id: "a" }, "done"), "done");
  });

  it("drops a deferred end when a new prompt starts", () => {
    const hold = fresh();
    foldSubagents(hold, { hook_event_name: "SubagentStart", agent_id: "a" }, "working");
    foldSubagents(hold, { hook_event_name: "Stop" }, "done");
    foldSubagents(hold, { hook_event_name: "UserPromptSubmit" }, "working");
    assert.equal(
      foldSubagents(hold, { hook_event_name: "SubagentStop", agent_id: "a" }, "working"),
      "working",
    );
  });
});
