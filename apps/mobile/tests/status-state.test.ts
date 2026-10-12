import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentStateOf,
  applyStatusEvent,
  emptyStatusState,
  type StatusEvent,
} from "../src/lib/status-state.ts";

const working = { worktreeId: "a-main", agent: { status: "working" } };
const waiting = { worktreeId: "b-main", agent: { status: "needs_attention" } };

function run(events: StatusEvent[]) {
  return events.reduce(applyStatusEvent, emptyStatusState());
}

describe("applyStatusEvent", () => {
  it("replaces the agent statuses on a snapshot and empties the branch statuses", () => {
    const before = run([
      { kind: "snapshot", statuses: [working] },
      { kind: "branch-status", worktreeId: "a-main", ci: { state: "success" } },
    ]);
    assert.equal(before.branches.size, 1);
    const after = applyStatusEvent(before, { kind: "snapshot", statuses: [waiting] });
    assert.deepEqual([...after.agents.keys()], ["b-main"]);
    assert.equal(after.branches.size, 0);
  });

  it("applies an update, a branch status and a removal", () => {
    const state = run([
      { kind: "snapshot", statuses: [] },
      { kind: "update", status: working },
      { kind: "branch-status", worktreeId: "a-main", ci: { state: "failure" } },
    ]);
    assert.equal(agentStateOf(state.agents.get("a-main")), "running");
    assert.equal(state.branches.get("a-main")?.ci?.state, "failure");
    const removed = applyStatusEvent(state, { kind: "remove", worktreeId: "a-main" });
    assert.equal(removed.agents.has("a-main"), false);
    assert.equal(removed.branches.has("a-main"), false);
  });

  it("does not change the previous state and ignores kinds it does not use", () => {
    const state = run([{ kind: "snapshot", statuses: [working] }]);
    const next = applyStatusEvent(state, { kind: "update", status: waiting });
    assert.equal(state.agents.size, 1);
    assert.equal(next.agents.size, 2);
    assert.equal(applyStatusEvent(state, { kind: "setup-status", worktreeId: "a-main" }), state);
  });
});

describe("agentStateOf", () => {
  it("maps working to running and needs_attention to attention", () => {
    assert.equal(agentStateOf(working), "running");
    assert.equal(agentStateOf(waiting), "attention");
  });

  it("is idle with no agent, a waiting agent or no status at all", () => {
    assert.equal(agentStateOf(undefined), "idle");
    assert.equal(agentStateOf({ worktreeId: "x", agent: { status: "waiting" } }), "idle");
  });

  it("lets attention in a tab win over a working agent", () => {
    const status = {
      worktreeId: "x",
      agent: { status: "working" },
      tabStatuses: [{ status: "needs_attention" }],
    };
    assert.equal(agentStateOf(status), "attention");
  });
});
