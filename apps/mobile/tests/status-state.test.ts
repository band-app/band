import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ageLabel,
  agentStateOf,
  applyStatusEvent,
  emptyStatusState,
  type StatusEvent,
  shownState,
  shownStateOf,
} from "../src/lib/status-state.ts";

const working = { worktreeId: "a-main", agent: { status: "working" } };
const waiting = { worktreeId: "b-main", agent: { status: "question" } };

function run(events: StatusEvent[]) {
  return events.reduce(applyStatusEvent, emptyStatusState());
}

describe("applyStatusEvent", () => {
  it("replaces the agent statuses on a snapshot and keeps the branch statuses", () => {
    const before = run([
      { kind: "snapshot", statuses: [working] },
      { kind: "branch-status", worktreeId: "a-main", ci: { state: "success" } },
      { kind: "branch-status", worktreeId: "b-main", ci: { state: "failure" } },
    ]);
    const after = applyStatusEvent(before, { kind: "snapshot", statuses: [waiting] });
    assert.deepEqual([...after.agents.keys()], ["b-main"]);
    assert.equal(after.branches.get("a-main")?.ci?.state, "success");
    assert.equal(after.branches.get("b-main")?.ci?.state, "failure");
  });

  it("drops a branch status the hub did not re-send after a snapshot", () => {
    let state = run([
      { kind: "snapshot", statuses: [working] },
      { kind: "branch-status", worktreeId: "a-main", ci: { state: "success" } },
      { kind: "branch-status", worktreeId: "b-main", ci: { state: "failure" } },
    ]);
    state = applyStatusEvent(state, { kind: "snapshot", statuses: [working] });
    state = applyStatusEvent(state, {
      kind: "branch-status",
      worktreeId: "a-main",
      ci: { state: "pending" },
    });
    // Never blank for the one that was re-sent, and B stays until the burst ends.
    assert.equal(state.branches.get("a-main")?.ci?.state, "pending");
    assert.equal(state.branches.has("b-main"), true);
    state = applyStatusEvent(state, { kind: "setup-status", worktreeId: "a-main" });
    assert.equal(state.branches.has("b-main"), false);
    assert.equal(state.branches.get("a-main")?.ci?.state, "pending");
  });

  it("keeps the old branch statuses through an agent update or remove that precedes the burst", () => {
    const before = run([
      { kind: "snapshot", statuses: [working] },
      { kind: "branch-status", worktreeId: "a-main", ci: { state: "success" } },
      { kind: "branch-status", worktreeId: "b-main", ci: { state: "failure" } },
    ]);
    const snap = applyStatusEvent(before, { kind: "snapshot", statuses: [working] });
    // An update for an unrelated worktree ends the replay early: the unsent entries go, which is
    // the documented rule, and a later branch-status still lands.
    const afterUpdate = applyStatusEvent(snap, { kind: "update", status: waiting });
    assert.equal(afterUpdate.branches.size, 0);
    const late = applyStatusEvent(afterUpdate, {
      kind: "branch-status",
      worktreeId: "a-main",
      ci: { state: "success" },
    });
    assert.equal(late.branches.get("a-main")?.ci?.state, "success");
    // A remove only drops its own worktree and, ending the replay, the stale ones.
    const afterRemove = applyStatusEvent(snap, { kind: "remove", worktreeId: "b-main" });
    assert.equal(afterRemove.branches.has("b-main"), false);
    assert.equal(afterRemove.staleBranches.size, 0);
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
  it("maps working and monitoring to running, question, done and failed to attention", () => {
    for (const status of ["working", "monitoring"]) {
      assert.equal(agentStateOf({ worktreeId: "x", agent: { status } }), "running");
    }
    for (const status of ["question", "done", "failed"]) {
      assert.equal(agentStateOf({ worktreeId: "x", agent: { status } }), "attention");
    }
    assert.equal(agentStateOf({ worktreeId: "x", agent: { status: "idle" } }), "idle");
  });

  it("still maps an older hub's working and needs_attention", () => {
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

describe("shownState", () => {
  it("shows each of the hub's states as itself", () => {
    for (const status of ["working", "monitoring", "question", "done", "failed", "idle"] as const) {
      assert.equal(shownState({ status }), status);
    }
  });

  it("maps an older hub's statuses to the design's icons", () => {
    assert.equal(shownState({ status: "working" }), "working");
    assert.equal(shownState({ status: "waiting" }), "idle");
    assert.equal(shownState({ status: undefined }), "idle");
    assert.equal(shownState({ status: "needs_attention", pending: true }), "question");
    assert.equal(shownState({ status: "needs_attention", pending: false }), "done");
    assert.equal(shownState({ status: "needs_attention", pending: false, failed: true }), "failed");
    // A worktree row can't tell, and a question is the case that needs the user.
    assert.equal(shownState({ status: "needs_attention" }), "question");
  });

  it("shows a worktree's most urgent agent", () => {
    assert.equal(shownStateOf(undefined), "idle");
    assert.equal(
      shownStateOf({
        worktreeId: "w",
        agent: { status: "working" },
        tabStatuses: [{ chatId: "c", status: "question" }],
      }),
      "question",
    );
    assert.equal(
      shownStateOf({
        worktreeId: "w",
        agent: { status: "done" },
        tabStatuses: [{ chatId: "c", status: "monitoring" }],
      }),
      "done",
    );
  });
});

describe("ageLabel edge cases", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("returns null with no time and clamps a future time to now", () => {
    assert.equal(ageLabel(null, now), null);
    assert.equal(ageLabel("2026-01-01T12:01:00Z", now), "now");
  });
});

describe("ageLabel", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("rounds down to minutes, hours and days", () => {
    assert.equal(ageLabel("2026-01-01T11:59:50Z", now), "now");
    assert.equal(ageLabel("2026-01-01T11:57:00Z", now), "3 m");
    assert.equal(ageLabel(now - 5 * 3_600_000, now), "5 h");
    assert.equal(ageLabel("2025-12-29T12:00:00Z", now), "3 d");
    assert.equal(ageLabel(undefined, now), null);
    assert.equal(ageLabel("nonsense", now), null);
  });
});
