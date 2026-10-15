import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asQueued,
  type CheckLike,
  canRerun,
  checkDuration,
  checkElapsed,
  countChecks,
  fixPrompt,
  rerunFailedPlan,
  rerunOneTarget,
} from "../src/checks.ts";

function check(over: Partial<CheckLike> & { id: string }): CheckLike {
  return {
    name: over.id,
    workflowName: null,
    state: "success",
    url: null,
    startedAt: null,
    completedAt: null,
    description: null,
    ...over,
  };
}

describe("countChecks", () => {
  it("counts neutral as passing and queued or running as pending", () => {
    const counts = countChecks([
      check({ id: "a", state: "success" }),
      check({ id: "b", state: "neutral" }),
      check({ id: "c", state: "failure" }),
      check({ id: "d", state: "running" }),
      check({ id: "e", state: "pending" }),
      check({ id: "f", state: "skipped" }),
    ]);
    assert.deepEqual(counts, { passing: 2, failing: 1, pending: 2 });
  });
});

describe("durations", () => {
  it("formats a finished check and a running one", () => {
    const done = check({
      id: "a",
      startedAt: "2026-10-15T10:00:00Z",
      completedAt: "2026-10-15T10:02:14Z",
    });
    assert.equal(checkDuration(done), "2m 14s");
    const running = check({ id: "b", state: "running", startedAt: "2026-10-15T10:00:00Z" });
    assert.equal(checkElapsed(running, Date.parse("2026-10-15T10:00:42Z")), "Running for 42s");
    assert.equal(checkElapsed(check({ id: "c", state: "pending" }), 0), "Queued");
  });
});

describe("re-run", () => {
  const failed = check({ id: "f1", state: "failure", rerun: { runId: "10", jobId: "11" } });
  const failedSameRun = check({ id: "f2", state: "failure", rerun: { runId: "10", jobId: "12" } });
  const failedOtherRun = check({ id: "f3", state: "failure", rerun: { runId: "20", jobId: "21" } });
  const external = check({ id: "x", state: "failure" });
  const running = check({ id: "r", state: "running", rerun: { runId: "30", jobId: "31" } });

  it("offers a re-run only for a finished job of a workflow run", () => {
    assert.equal(canRerun(failed), true);
    assert.equal(canRerun(external), false);
    assert.equal(canRerun(running), false);
  });

  it("asks for one job", () => {
    assert.deepEqual(rerunOneTarget(failed), [{ runId: "10", jobId: "11" }]);
    assert.deepEqual(rerunOneTarget(external), []);
  });

  it("asks once per run for the failed jobs", () => {
    const plan = rerunFailedPlan([failed, failedSameRun, failedOtherRun, external, running]);
    assert.deepEqual(plan.targets, [
      { runId: "10", failedOnly: true },
      { runId: "20", failedOnly: true },
    ]);
    assert.deepEqual(
      plan.covered.map((c) => c.id),
      ["f1", "f2", "f3"],
    );
  });

  it("shows a requeued check as pending", () => {
    const queued = asQueued(failed);
    assert.equal(queued.state, "pending");
    assert.equal(queued.description, null);
  });
});

describe("fixPrompt", () => {
  it("names the pull request, the failing jobs and their links", () => {
    const text = fixPrompt("feat/x", { number: 7, title: "Add x" }, [
      check({ id: "a", name: "unit", workflowName: "CI", url: "https://github.com/o/r/runs/1" }),
      check({ id: "b", name: "lint" }),
    ]);
    assert.match(text, /^These CI checks are failing on pull request #7 \(Add x\):/);
    assert.match(text, /- CI \/ unit: https:\/\/github.com\/o\/r\/runs\/1/);
    assert.match(text, /- lint\n/);
  });

  it("names the branch when there is no pull request", () => {
    assert.match(fixPrompt("feat/x", null, []), /failing on branch feat\/x:/);
  });
});
