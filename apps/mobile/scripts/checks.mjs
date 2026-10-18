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
  commentNode,
  reviewNode,
  reviewThreadNode,
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
  DISCUSSION: "feat/discussion",
  MERGE_SQUASH: "feat/merge-squash",
  MERGE_REBASE: "feat/merge-rebase",
  MERGE_BLOCKED: "feat/merge-blocked",
  MERGE_REFUSED: "feat/merge-refused",
};

/** The `gh pr merge` calls the hub made: `{ number, method }`. */
export const merges = [];
const mergedPrs = new Set();

/** A pull request that merges with the `gh pr merge` stub; once merged it reads as MERGED. */
function mergePr(number, title, extra = {}) {
  return () =>
    reviewQueryData({
      pullRequests: [
        pullRequestNode({
          number,
          title,
          state: mergedPrs.has(number) ? "MERGED" : "OPEN",
          ...extra,
        }),
      ],
    });
}

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
  stub.setReviewQuery(
    repo,
    CHECKS_BRANCHES.DISCUSSION,
    reviewQueryData({
      pullRequests: [
        pullRequestNode({
          number: 50,
          title: "Discuss the parser",
          reviews: [
            reviewNode({
              id: "r1",
              login: "carol",
              state: "APPROVED",
              body: "Looks **good** to me.",
              submittedAt: "2026-01-02T08:45:00Z",
            }),
          ],
          comments: [
            commentNode({
              id: "c1",
              login: "bob",
              body: "Can you add a test for the `empty` case?",
              createdAt: "2026-01-02T08:30:00Z",
            }),
            commentNode({
              id: "c2",
              login: "alice",
              body: "Added in the last commit.",
              createdAt: "2026-01-02T08:40:00Z",
            }),
          ],
          reviewThreads: [
            reviewThreadNode({
              id: "t1",
              path: "src/parser.ts",
              line: 12,
              comments: [
                commentNode({ id: "t1a", login: "bob", body: "Why not a `Map` here?" }),
                commentNode({
                  id: "t1b",
                  login: "alice",
                  body: "A `Map` keeps insertion order.",
                  createdAt: "2026-01-02T08:50:00Z",
                }),
              ],
            }),
            reviewThreadNode({
              id: "t2",
              path: "src/lexer.ts",
              line: 3,
              isResolved: true,
              comments: [commentNode({ id: "t2a", login: "bob", body: "Typo in the name." })],
            }),
            reviewThreadNode({
              id: "t3",
              path: "src/old.ts",
              line: 9,
              isOutdated: true,
              comments: [commentNode({ id: "t3a", login: "carol", body: "This moved." })],
            }),
          ],
        }),
      ],
    }),
  );
  stub.setReviewQuery(repo, CHECKS_BRANCHES.MERGE_SQUASH, mergePr(51, "Merge by squash"));
  stub.setReviewQuery(repo, CHECKS_BRANCHES.MERGE_REBASE, mergePr(52, "Merge by rebase"));
  stub.setReviewQuery(
    repo,
    CHECKS_BRANCHES.MERGE_BLOCKED,
    mergePr(53, "Waiting for review", { mergeStateStatus: "BLOCKED" }),
  );
  stub.setReviewQuery(repo, CHECKS_BRANCHES.MERGE_REFUSED, mergePr(54, "GitHub says no"));
  for (const number of [51, 52]) {
    stub.setPrMerge(number, {
      onRequest: (r) => {
        const method = ["squash", "merge", "rebase"].find((m) => r.flags[m] === true);
        merges.push({ number, method });
        mergedPrs.add(number);
      },
    });
  }
  stub.setPrMerge(54, {
    stderr: "GraphQL: Pull request is not mergeable (mergePullRequest)",
    onRequest: (r) => {
      const method = ["squash", "merge", "rebase"].find((m) => r.flags[m] === true);
      merges.push({ number: 54, method });
    },
  });
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

/** Fails unless `gh pr merge` was called as `want` says: `{ number, method }`. */
export function expectMerge(want) {
  const hit = merges.find((m) => m.number === want.number && m.method === want.method);
  if (!hit) throw new Error(`no gh pr merge ${JSON.stringify(want)}; got ${JSON.stringify(merges)}`);
  return hit;
}

/** Fails when `gh pr merge` was called for this pull request. */
export function expectNoMerge(number) {
  if (merges.some((m) => m.number === number)) {
    throw new Error(`gh pr merge #${number} was called: ${JSON.stringify(merges)}`);
  }
}
