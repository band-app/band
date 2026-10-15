/**
 * The fake GitHub for the Checks flows. It wraps the hub tests' `gh` stub (`BAND_GH_BIN` points
 * the hub's GitHub plugin at a fake binary that asks an Express stub) and answers the plugin's
 * review query for the `acme/widgets` worktrees `seedChecks` makes, from state the flows change:
 *
 * - `feat/checks`: PR 42 with a passed Lint, a failed Unit (run 600), a running Build, a queued
 *   Deploy and a failed check from an app that cannot run again. `finishBuild` completes Build.
 * - `feat/rerun`: PR 43 with three failed jobs in runs 600 and 601. `gh run rerun` starts the
 *   job again, the way GitHub does with a new job id.
 * - `feat/nochecks`: PR 44 with no checks. `feat/nopr`: no PR and no jobs on the branch.
 */
import { ghStub } from "../../hub/tests/fixtures/gh-stub.ts";
import {
  checkRunNode,
  FAKE_REPO,
  pullRequestNode,
  reviewQueryData,
} from "../../hub/tests/fixtures/github-review-data.ts";

export const CHECKS_REPO = FAKE_REPO.name;
export const CHECKS_BRANCHES = {
  CHECKS: "feat/checks",
  RERUN: "feat/rerun",
  NO_CHECKS: "feat/nochecks",
  NO_PR: "feat/nopr",
};

const state = { buildDone: false, restarted: new Set() };
/** The `gh run rerun` calls the hub made: `{ runId, flags }`. */
export const reruns = [];

function checksData() {
  const build = state.buildDone;
  return reviewQueryData({
    pullRequests: [
      pullRequestNode({
        number: 42,
        title: "Add the checks view",
        contexts: [
          checkRunNode({ id: 60, name: "Lint", workflow: "CI", runId: 600, rerunnable: true }),
          checkRunNode({
            id: 61,
            name: "Unit",
            workflow: "CI",
            runId: 600,
            rerunnable: true,
            conclusion: "FAILURE",
            title: "3 tests failed in parser.test.ts",
            ...(state.restarted.has("61") && {
              id: 161,
              status: "IN_PROGRESS",
              conclusion: null,
              completedAt: null,
            }),
          }),
          checkRunNode({
            id: 62,
            name: "Build",
            workflow: "CI",
            runId: 600,
            rerunnable: true,
            status: build ? "COMPLETED" : "IN_PROGRESS",
            conclusion: build ? "SUCCESS" : null,
            startedAt: build ? "2026-01-01T10:00:00Z" : new Date(Date.now() - 20_000).toISOString(),
            completedAt: build ? "2026-01-01T10:01:40Z" : null,
          }),
          checkRunNode({
            id: 63,
            name: "Deploy",
            workflow: "Release",
            runId: 601,
            rerunnable: true,
            status: "QUEUED",
            conclusion: null,
            startedAt: null,
            completedAt: null,
          }),
          checkRunNode({ id: 64, name: "Coverage", workflow: null, conclusion: "FAILURE" }),
        ],
      }),
    ],
  });
}

function rerunData() {
  const job = (id, name, runId) =>
    checkRunNode({
      id,
      name,
      workflow: "CI",
      runId,
      rerunnable: true,
      conclusion: "FAILURE",
      ...(state.restarted.has(String(id)) && {
        id: id + 100,
        status: "IN_PROGRESS",
        conclusion: null,
        completedAt: null,
      }),
    });
  return reviewQueryData({
    pullRequests: [
      pullRequestNode({
        number: 43,
        title: "Fix the flaky jobs",
        contexts: [job(71, "Unit", 700), job(72, "Lint", 700), job(73, "E2E", 701)],
      }),
    ],
  });
}

/** Starts the stub. `env` goes to the hub's environment. */
export async function startGhStub() {
  const stub = await ghStub.start();
  const repo = FAKE_REPO;
  stub.setReviewQuery(repo, CHECKS_BRANCHES.CHECKS, checksData);
  stub.setReviewQuery(repo, CHECKS_BRANCHES.RERUN, rerunData);
  stub.setReviewQuery(
    repo,
    CHECKS_BRANCHES.NO_CHECKS,
    reviewQueryData({ pullRequests: [pullRequestNode({ number: 44, title: "Docs only" })] }),
  );
  stub.setReviewQuery(repo, CHECKS_BRANCHES.NO_PR, reviewQueryData({}));
  stub.setBranchStatusQuery(repo, () => null);
  // `gh run rerun <run> --job <id>` restarts that job; `--failed` restarts every failed one of the run.
  for (const runId of [600, 700, 701]) {
    stub.setRunRerun(runId, {
      onRequest: (r) => {
        const flags = r.flags;
        reruns.push({ runId, failed: flags.failed === true, job: flags.job ?? null });
        if (flags.job) state.restarted.add(String(flags.job));
        else if (runId === 700) for (const id of ["71", "72"]) state.restarted.add(id);
        else if (runId === 701) state.restarted.add("73");
      },
    });
  }
  return stub;
}

/** Build, the running job of `feat/checks`, passes. */
export function finishBuild() {
  state.buildDone = true;
}

/** Fails unless `gh run rerun` was called as `want` says: `{ runId, failed?, job? }`. */
export function expectRerun(want) {
  const hit = reruns.find(
    (r) =>
      r.runId === want.runId && r.failed === Boolean(want.failed) && (want.job ?? null) === r.job,
  );
  if (!hit) throw new Error(`no gh run rerun ${JSON.stringify(want)}; got ${JSON.stringify(reruns)}`);
  return hit;
}
