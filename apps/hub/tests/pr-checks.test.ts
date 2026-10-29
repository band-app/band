/**
 * The review panel's backend: `reviews.forWorktree`, `reviews.merge` and
 * `reviews.rerunChecks`,
 * served by the bundled GitHub plugin through the plugin host.
 *
 * Real server, real git repos with a github.com `origin`, and a fake `gh`
 * (`fixtures/gh-stub-bin.mjs` + the Express stub in `fixtures/gh-stub.ts`)
 * selected through `BAND_GH_BIN`, so the plugin's subprocess calls are
 * answered and recorded without network or auth.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GhInvocation, type GhStub, ghStub } from "./fixtures/gh-stub";
import {
  checkRunNode,
  checkSuiteNode,
  commentNode,
  FAKE_REPO,
  jobUrl,
  pullRequestNode,
  reviewNode,
  reviewQueryData,
  reviewRequestNode,
  reviewThreadNode,
  statusContextNode,
} from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { isRemoteLoopback, testWorktreeId } from "./helpers/test-host";

const TOKEN = "pr-checks-test-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/** Where the plugin's `gh` runs: the worktree, on the hub or on the worker that holds it. */
function ghCwd(worktree: string): string {
  return worktree;
}

/** The hub's gh runs with prompts off; a worker's own gh has no terminal and never prompts. */
const ghPromptDisabled = isRemoteLoopback ? null : "1";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

/** A repo on `main` with one commit and `origin` set to `remote`. */
function createRepo(parent: string, name: string, remote: string | null): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  writeFileSync(join(path, "README.md"), "hello\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "init"]);
  if (remote) git(path, ["remote", "add", "origin", remote]);
  return path;
}

function addWorktree(repo: string, parent: string, branch: string): string {
  const path = join(parent, `wt-${branch.replaceAll("/", "-")}`);
  git(repo, ["worktree", "add", "-b", branch, path]);
  return path;
}

async function forWorktree(server: ServerHandle, worktreeId: string) {
  const res = await trpcQuery(server.url, "reviews.forWorktree", { worktreeId }, TOKEN);
  expect(res.status).toBe(200);
  return trpcData<Record<string, unknown>>(res);
}

const REPO = "widgets";
const PR_BRANCH = "feat/login";
const BRANCH_ONLY = "feat/no-pr";
const FAILING_BRANCH = "feat/gh-down";
const DISCUSSION_BRANCH = "feat/discussion";
const MERGE_BRANCH = "feat/merge-me";
const MERGE_FAIL_BRANCH = "feat/merge-blocked";
const RERUN_BRANCH = "feat/rerun";
const DRAFT_BRANCH = "feat/draft";

describe("reviews.forWorktree and reviews.merge (GitHub plugin)", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  let prWorktree: string;
  let mergeWorktree: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-pr-checks-");
    const repo = createRepo(
      tmpHome,
      REPO,
      `git@github.com:${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
    );
    prWorktree = addWorktree(repo, tmpHome, PR_BRANCH);
    const branchOnlyWorktree = addWorktree(repo, tmpHome, BRANCH_ONLY);
    const failingWorktree = addWorktree(repo, tmpHome, FAILING_BRANCH);
    const discussionWorktree = addWorktree(repo, tmpHome, DISCUSSION_BRANCH);
    mergeWorktree = addWorktree(repo, tmpHome, MERGE_BRANCH);
    const mergeFailWorktree = addWorktree(repo, tmpHome, MERGE_FAIL_BRANCH);
    const rerunWorktree = addWorktree(repo, tmpHome, RERUN_BRANCH);
    const draftWorktree = addWorktree(repo, tmpHome, DRAFT_BRANCH);
    const noRemote = createRepo(tmpHome, "local-only", null);
    const gitlab = createRepo(tmpHome, "on-gitlab", "https://gitlab.com/acme/widgets.git");

    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repo,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repo },
            { name: PR_BRANCH, branch: PR_BRANCH, path: prWorktree },
            { name: BRANCH_ONLY, branch: BRANCH_ONLY, path: branchOnlyWorktree },
            { name: FAILING_BRANCH, branch: FAILING_BRANCH, path: failingWorktree },
            { name: DISCUSSION_BRANCH, branch: DISCUSSION_BRANCH, path: discussionWorktree },
            { name: MERGE_BRANCH, branch: MERGE_BRANCH, path: mergeWorktree },
            { name: MERGE_FAIL_BRANCH, branch: MERGE_FAIL_BRANCH, path: mergeFailWorktree },
            { name: RERUN_BRANCH, branch: RERUN_BRANCH, path: rerunWorktree },
            { name: DRAFT_BRANCH, branch: DRAFT_BRANCH, path: draftWorktree },
          ],
        },
        {
          name: "local-only",
          path: noRemote,
          defaultBranch: "main",
          hasOrigin: false,
          worktrees: [{ name: "main", branch: "main", path: noRemote }],
        },
        {
          name: "on-gitlab",
          path: gitlab,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: gitlab }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await ghStub.start();
    server = await startServer({ tmpHome, env: stub.env });
  });

  afterAll(async () => {
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns the branch's pull request with every check on its head commit", async () => {
    const requests: GhInvocation[] = [];
    stub.setReviewQuery(
      FAKE_REPO,
      PR_BRANCH,
      reviewQueryData({
        pullRequests: [
          pullRequestNode({
            number: 697,
            title: "fix(web): pad the top inset",
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            headOid: "abcdef1234567890abcdef1234567890abcdef12",
            contexts: [
              checkRunNode({
                id: 11,
                name: "Detect CLI-relevant changes",
                workflow: "CI",
                runId: 500,
              }),
              checkRunNode({
                id: 12,
                name: "Claude review",
                workflow: "Review",
                runId: 501,
                conclusion: "FAILURE",
                title: "2 issues found",
              }),
              checkRunNode({
                id: 13,
                name: "Lint, Test & Build",
                workflow: "CI",
                runId: 500,
                status: "IN_PROGRESS",
                conclusion: null,
                completedAt: null,
              }),
              checkRunNode({
                id: 14,
                name: "CLI Integration Tests (macOS)",
                workflow: "CI",
                runId: 500,
                conclusion: "SKIPPED",
              }),
              statusContextNode({
                id: "SC_1",
                context: "deploy/preview",
                state: "SUCCESS",
                targetUrl: "https://preview.example.test/697",
                description: "Preview ready",
              }),
            ],
          }),
        ],
      }),
      { onRequest: (r) => requests.push(r) },
    );

    // Failing first, then running, then passing, then skipped.
    const expectedChecks = {
      state: "failure",
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
      checks: [
        {
          id: "check-run-12",
          name: "Claude review",
          workflowName: "Review",
          state: "failure",
          url: jobUrl(501, 12),
          startedAt: "2026-01-01T10:00:00Z",
          completedAt: "2026-01-01T10:02:14Z",
          description: "2 issues found",
        },
        {
          id: "check-run-13",
          name: "Lint, Test & Build",
          workflowName: "CI",
          state: "running",
          url: jobUrl(500, 13),
          startedAt: "2026-01-01T10:00:00Z",
          completedAt: null,
          description: null,
        },
        {
          id: "status-SC_1",
          name: "deploy/preview",
          workflowName: null,
          state: "success",
          url: "https://preview.example.test/697",
          startedAt: "2026-01-01T10:00:00Z",
          completedAt: null,
          description: "Preview ready",
        },
        {
          id: "check-run-11",
          name: "Detect CLI-relevant changes",
          workflowName: "CI",
          state: "success",
          url: jobUrl(500, 11),
          startedAt: "2026-01-01T10:00:00Z",
          completedAt: "2026-01-01T10:02:14Z",
          description: null,
        },
        {
          id: "check-run-14",
          name: "CLI Integration Tests (macOS)",
          workflowName: "CI",
          state: "skipped",
          url: jobUrl(500, 14),
          startedAt: "2026-01-01T10:00:00Z",
          completedAt: "2026-01-01T10:02:14Z",
          description: null,
        },
      ],
    };

    const data = await forWorktree(server, testWorktreeId(REPO, PR_BRANCH));

    expect(data).toEqual({
      status: "ok",
      provider: {
        id: "github",
        name: "GitHub",
        fixHint: "for example with `gh run view <run-id> --log-failed`",
      },
      repo: { host: "github.com", owner: "acme", repo: "widgets" },
      branch: PR_BRANCH,
      review: {
        number: 697,
        url: "https://github.com/acme/widgets/pull/697",
        title: "fix(web): pad the top inset",
        state: "open",
        updatedAt: "2026-01-02T09:30:00Z",
        reviewDecision: "review_required",
        mergeState: "blocked",
        checks: expectedChecks,
        reviewers: [],
        discussion: { items: [], threads: [] },
        actions: [
          ["squash", "Squash and merge"],
          ["merge", "Create a merge commit"],
          ["rebase", "Rebase and merge"],
        ].map(([method, label]) => ({
          id: "merge",
          label,
          icon: "merge",
          placement: "header",
          group: "merge",
          args: { method },
          confirm: `${label} #697?`,
          disabledReason: "Required reviews or checks are missing.",
        })),
      },
      checks: expectedChecks,
      fetchedAt: expect.any(String),
    });

    // One `gh api graphql` call per lookup, against github.com (no
    // --hostname), run in the worktree's worktree with prompts disabled.
    expect(requests).toHaveLength(1);
    expect(requests[0].positional).toEqual(["api", "graphql"]);
    expect(requests[0].fields).toEqual({
      query: expect.stringContaining("pullRequests(headRefName: $branch"),
      owner: "acme",
      name: "widgets",
      branch: PR_BRANCH,
      ref: `refs/heads/${PR_BRANCH}`,
    });
    expect(requests[0].flags).toEqual({});
    expect(requests[0].cwd).toBe(ghCwd(prWorktree));
    expect(requests[0].env).toEqual({ GH_PROMPT_DISABLED: ghPromptDisabled });
    expect(stub.requests).toContainEqual(requests[0]);
  });

  it("returns reviewers with their latest state and the pull request's discussion", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      DISCUSSION_BRANCH,
      reviewQueryData({
        pullRequests: [
          pullRequestNode({
            number: 720,
            reviewRequests: [
              reviewRequestNode("carol", { asCodeOwner: true }),
              // Asked again after approving: pending wins.
              reviewRequestNode("dave"),
            ],
            reviews: [
              reviewNode({
                id: "R1",
                login: "bob",
                state: "CHANGES_REQUESTED",
                body: "Please **rename** this.",
                submittedAt: "2026-01-02T08:00:00Z",
              }),
              reviewNode({
                id: "R2",
                login: "bob",
                state: "APPROVED",
                submittedAt: "2026-01-02T10:00:00Z",
              }),
              // A comment after an approval does not replace the verdict.
              reviewNode({
                id: "R3",
                login: "bob",
                state: "COMMENTED",
                body: "One more thought.",
                submittedAt: "2026-01-02T11:00:00Z",
              }),
              reviewNode({ id: "R4", login: "dave", state: "APPROVED" }),
              reviewNode({ id: "R5", login: "erin", state: "PENDING", body: "draft" }),
            ],
            comments: [
              commentNode({
                id: "C1",
                login: "alice",
                body: "Looks `good`.",
                createdAt: "2026-01-02T07:00:00Z",
              }),
            ],
            reviewThreads: [
              reviewThreadNode({
                id: "T1",
                path: "src/login.ts",
                line: 42,
                comments: [
                  commentNode({
                    id: "TC1",
                    login: "bob",
                    body: "Why not a const?",
                    createdAt: "2026-01-02T09:00:00Z",
                  }),
                  commentNode({
                    id: "TC2",
                    login: "alice",
                    body: "Done.",
                    createdAt: "2026-01-02T09:05:00Z",
                  }),
                ],
              }),
              reviewThreadNode({
                id: "T2",
                path: "src/old.ts",
                line: null,
                isResolved: true,
                isOutdated: true,
                comments: [
                  commentNode({
                    id: "TC3",
                    login: "bob",
                    body: "Nit.",
                    createdAt: "2026-01-02T09:30:00Z",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );

    const data = await forWorktree(server, testWorktreeId(REPO, DISCUSSION_BRANCH));
    const review = data.review as {
      reviewers: Array<Record<string, unknown>>;
      discussion: {
        items: Array<Record<string, unknown>>;
        threads: Array<Record<string, unknown>>;
      };
    };

    expect(review.reviewers.map((r) => [r.login, r.state, r.required ?? false])).toEqual([
      ["bob", "approved", false],
      ["dave", "pending", false],
      ["carol", "pending", true],
    ]);
    expect(review.reviewers[0].avatarUrl).toBe("https://avatars.example.test/bob.png");

    // Conversation comments and review summaries with a body, oldest first.
    expect(review.discussion.items.map((i) => [i.id, i.kind, i.reviewState ?? null])).toEqual([
      ["C1", "comment", null],
      ["R1", "review", "changes_requested"],
      ["R3", "review", "commented"],
    ]);
    expect(review.discussion.items[0].body).toBe("Looks `good`.");
    expect(review.discussion.items[0].url).toBe(
      "https://github.com/acme/widgets/pull/1#issuecomment-C1",
    );

    expect(review.discussion.threads).toMatchObject([
      {
        id: "T1",
        path: "src/login.ts",
        line: 42,
        isResolved: false,
        isOutdated: false,
        comments: [
          { id: "TC1", body: "Why not a const?", author: { login: "bob" } },
          { id: "TC2", body: "Done.", author: { login: "alice" } },
        ],
      },
      { id: "T2", path: "src/old.ts", isResolved: true, isOutdated: true },
    ]);
  });

  it("returns the branch's GitHub Actions jobs when it has no pull request", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      BRANCH_ONLY,
      reviewQueryData({
        // A pull request from a fork that happens to use the same branch name.
        pullRequests: [pullRequestNode({ number: 5, isCrossRepository: true })],
        headOid: "3333333333333333333333333333333333333333",
        suites: [
          checkSuiteNode("CI", [
            checkRunNode({ id: 21, name: "Build", runId: 600 }),
            // An older run of the same job.
            checkRunNode({
              id: 20,
              name: "Build",
              runId: 599,
              conclusion: "FAILURE",
              startedAt: "2026-01-01T09:00:00Z",
            }),
            checkRunNode({ id: 22, name: "Test", runId: 600, status: "QUEUED", conclusion: null }),
          ]),
          // A third-party app's suite has no workflow run and is left out.
          checkSuiteNode(null, [
            checkRunNode({ id: 30, name: "External scanner", workflow: null }),
          ]),
        ],
      }),
    );

    const data = await forWorktree(server, testWorktreeId(REPO, BRANCH_ONLY));

    expect(data).toEqual({
      status: "ok",
      provider: {
        id: "github",
        name: "GitHub",
        fixHint: "for example with `gh run view <run-id> --log-failed`",
      },
      repo: { host: "github.com", owner: "acme", repo: "widgets" },
      branch: BRANCH_ONLY,
      review: null,
      checks: {
        state: "pending",
        headSha: "3333333333333333333333333333333333333333",
        checks: [
          {
            id: "check-run-22",
            name: "Test",
            workflowName: "CI",
            state: "pending",
            url: jobUrl(600, 22),
            startedAt: "2026-01-01T10:00:00Z",
            completedAt: "2026-01-01T10:02:14Z",
            description: null,
          },
          {
            id: "check-run-21",
            name: "Build",
            workflowName: "CI",
            state: "success",
            url: jobUrl(600, 21),
            startedAt: "2026-01-01T10:00:00Z",
            completedAt: "2026-01-01T10:02:14Z",
            description: null,
          },
        ],
      },
      fetchedAt: expect.any(String),
    });
  });

  it("ignores pull requests whose head is the default branch", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      "main",
      reviewQueryData({
        pullRequests: [pullRequestNode({ number: 3, state: "MERGED" })],
        suites: [checkSuiteNode("CI", [checkRunNode({ id: 41, name: "Build", runId: 700 })])],
      }),
    );

    const data = await forWorktree(server, testWorktreeId(REPO, "main"));

    expect(data.review).toBeNull();
    expect(data.checks).toEqual({
      state: "success",
      headSha: "2222222222222222222222222222222222222222",
      checks: [
        {
          id: "check-run-41",
          name: "Build",
          workflowName: "CI",
          state: "success",
          url: jobUrl(700, 41),
          startedAt: "2026-01-01T10:00:00Z",
          completedAt: "2026-01-01T10:02:14Z",
          description: null,
        },
      ],
    });
  });

  it("reports a gh failure as an error result with gh's message", async () => {
    stub.setReviewQueryError(FAKE_REPO, FAILING_BRANCH, "HTTP 401: Bad credentials\n");

    const data = await forWorktree(server, testWorktreeId(REPO, FAILING_BRANCH));

    if (isRemoteLoopback) {
      // S3: the worker's gh and the hub's fallback both fail, so the error names both and the fix.
      expect(data).toMatchObject({ status: "error" });
      const message = (data as { message: string }).message;
      expect(message).toContain("Worker h-");
      expect(message).toContain("Hub: HTTP 401: Bad credentials");
      expect(message).toContain("gh auth login on h-");
      expect(message).toContain("band vault put --kind git --host github.com");
    } else {
      expect(data).toEqual({ status: "error", message: "HTTP 401: Bad credentials" });
    }
  });

  it("reports repos the plugin can't serve as unavailable", async () => {
    expect(await forWorktree(server, testWorktreeId("local-only", "main"))).toEqual({
      status: "unavailable",
      reason: "no-remote",
      message: "The repo has no origin remote.",
    });
    expect(await forWorktree(server, testWorktreeId("on-gitlab", "main"))).toEqual({
      status: "unavailable",
      reason: "no-provider",
      message: "No enabled plugin handles gitlab.com.",
    });
  });

  it("merges the branch's open pull request with the chosen method", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      MERGE_BRANCH,
      reviewQueryData({ pullRequests: [pullRequestNode({ number: 801 })] }),
    );
    const merges: GhInvocation[] = [];
    stub.setPrMerge(801, { onRequest: (r) => merges.push(r) });

    const res = await trpcMutate(
      server.url,
      "reviews.merge",
      { worktreeId: testWorktreeId(REPO, MERGE_BRANCH), method: "squash" },
      TOKEN,
    );

    expect(res.status).toBe(200);
    expect(await trpcData(res)).toEqual({ ok: true });
    expect(merges).toEqual([
      {
        args: ["pr", "merge", "801", "--squash", "--repo", "github.com/acme/widgets"],
        positional: ["pr", "merge", "801"],
        fields: {},
        flags: { squash: true, repo: "github.com/acme/widgets" },
        cwd: ghCwd(mergeWorktree),
        env: { GH_PROMPT_DISABLED: ghPromptDisabled },
      },
    ]);
  });

  it("offers merge, ready and re-run as actions, and runs one by id", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      DRAFT_BRANCH,
      reviewQueryData({
        pullRequests: [pullRequestNode({ number: 802, isDraft: true, mergeStateStatus: "DRAFT" })],
      }),
    );
    const ready: GhInvocation[] = [];
    stub.setPrReady(802, { onRequest: (r) => ready.push(r) });
    const worktreeId = testWorktreeId(REPO, DRAFT_BRANCH);

    const data = (await forWorktree(server, worktreeId)) as {
      review: { actions: Array<Record<string, unknown>> };
    };
    const actions = data.review.actions;
    expect(actions.map((a) => a.id)).toEqual(["merge", "merge", "merge", "ready"]);
    expect(actions[0]).toMatchObject({
      args: { method: "squash" },
      group: "merge",
      confirm: "Squash and merge #802?",
      disabledReason: "Mark the PR ready for review first.",
    });
    expect(actions[3]).toEqual({
      id: "ready",
      label: "Ready for review",
      icon: "ready",
      placement: "header",
    });

    const res = await trpcMutate(
      server.url,
      "reviews.runAction",
      { worktreeId, actionId: "ready", args: {} },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect(ready.map((r) => r.args)).toEqual([
      ["pr", "ready", "802", "--repo", "github.com/acme/widgets"],
    ]);

    const unknown = await trpcMutate(
      server.url,
      "reviews.runAction",
      { worktreeId, actionId: "delete-everything", args: {} },
      TOKEN,
    );
    expect(unknown.status).toBe(400);
  });

  it("returns gh's message when the merge fails", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      MERGE_FAIL_BRANCH,
      reviewQueryData({ pullRequests: [pullRequestNode({ number: 802 })] }),
    );
    stub.setPrMerge(802, {
      stderr:
        "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge.\n",
    });

    const res = await trpcMutate(
      server.url,
      "reviews.merge",
      { worktreeId: testWorktreeId(REPO, MERGE_FAIL_BRANCH), method: "merge" },
      TOKEN,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge.",
    );
  });

  it("marks only finished jobs of a workflow run as re-runnable", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      RERUN_BRANCH,
      reviewQueryData({
        pullRequests: [
          pullRequestNode({
            number: 900,
            contexts: [
              checkRunNode({ id: 21, name: "Unit", workflow: "CI", runId: 700, rerunnable: true }),
              checkRunNode({
                id: 22,
                name: "Build",
                workflow: "CI",
                runId: 700,
                rerunnable: true,
                status: "IN_PROGRESS",
                conclusion: null,
                completedAt: null,
              }),
              checkRunNode({ id: 23, name: "External app", workflow: null }),
            ],
          }),
        ],
      }),
    );

    const data = await forWorktree(server, testWorktreeId(REPO, RERUN_BRANCH));

    const checks = (
      data as { checks: { checks: { name: string; state: string; rerun?: unknown }[] } }
    ).checks.checks;
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.Unit.rerun).toEqual({ runId: "700", jobId: "21" });
    // The review offers a re-run for the finished job only, and one "re-run failed" per run with a failure.
    const actions = (data as { review: { actions: unknown[] } }).review.actions;
    expect(actions).toContainEqual({
      id: "rerun-job",
      label: "Re-run job",
      icon: "rerun",
      placement: "check",
      args: { runId: "700", jobId: "21", checkId: "check-run-21" },
    });
    expect(actions).not.toContainEqual(
      expect.objectContaining({ args: expect.objectContaining({ jobId: "22" }) }),
    );
    // The panel hides the button for a running job; the data still names its run.
    expect(byName.Build.state).toBe("running");
    expect(byName["External app"].rerun).toBeUndefined();
  });

  it("re-runs one job, and failed jobs once per run", async () => {
    const calls: GhInvocation[] = [];
    stub.setRunRerun(700, { onRequest: (r) => calls.push(r) });
    stub.setRunRerun(701, { onRequest: (r) => calls.push(r) });
    const worktreeId = testWorktreeId(REPO, RERUN_BRANCH);

    const one = await trpcMutate(
      server.url,
      "reviews.rerunChecks",
      { worktreeId, targets: [{ runId: "700", jobId: "21" }] },
      TOKEN,
    );
    expect(one.status).toBe(200);
    expect(await trpcData(one)).toEqual({ ok: true });

    const failed = await trpcMutate(
      server.url,
      "reviews.rerunChecks",
      {
        worktreeId,
        targets: [
          { runId: "700", failedOnly: true },
          { runId: "701", failedOnly: true },
        ],
      },
      TOKEN,
    );
    expect(failed.status).toBe(200);

    expect(calls.map((c) => c.args)).toEqual([
      ["run", "rerun", "700", "--job", "21", "--repo", "github.com/acme/widgets"],
      ["run", "rerun", "700", "--failed", "--repo", "github.com/acme/widgets"],
      ["run", "rerun", "701", "--failed", "--repo", "github.com/acme/widgets"],
    ]);
  });

  it("returns gh's message when a re-run is refused", async () => {
    stub.setRunRerun(702, {
      stderr: "run 702 cannot be rerun; its workflow run is older than 30 days\n",
    });

    const res = await trpcMutate(
      server.url,
      "reviews.rerunChecks",
      { worktreeId: testWorktreeId(REPO, RERUN_BRANCH), targets: [{ runId: "702", jobId: "9" }] },
      TOKEN,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "run 702 cannot be rerun; its workflow run is older than 30 days",
    );
  });

  it("re-runs a job on a branch with no pull request", async () => {
    const calls: GhInvocation[] = [];
    stub.setRunRerun(710, { onRequest: (r) => calls.push(r) });

    const res = await trpcMutate(
      server.url,
      "reviews.rerunChecks",
      { worktreeId: testWorktreeId(REPO, BRANCH_ONLY), targets: [{ runId: "710", jobId: "5" }] },
      TOKEN,
    );

    expect(res.status).toBe(200);
    expect(calls.map((c) => c.args)).toEqual([
      ["run", "rerun", "710", "--job", "5", "--repo", "github.com/acme/widgets"],
    ]);
  });

  it("rejects a re-run that names neither a job nor the failed jobs", async () => {
    const res = await trpcMutate(
      server.url,
      "reviews.rerunChecks",
      { worktreeId: testWorktreeId(REPO, RERUN_BRANCH), targets: [{ runId: "700" }] },
      TOKEN,
    );

    expect(res.status).toBe(400);
  });

  it("refuses to merge a branch that has no open pull request", async () => {
    stub.setReviewQuery(
      FAKE_REPO,
      BRANCH_ONLY,
      // Only a fork's pull request uses this branch name, and that isn't the branch's review.
      reviewQueryData({ pullRequests: [pullRequestNode({ number: 5, isCrossRepository: true })] }),
    );
    const merges: GhInvocation[] = [];
    stub.setPrMerge(5, { onRequest: (r) => merges.push(r) });

    const res = await trpcMutate(
      server.url,
      "reviews.merge",
      { worktreeId: testWorktreeId(REPO, BRANCH_ONLY), method: "merge" },
      TOKEN,
    );

    expect(res.status).toBe(412);
    expect(merges).toEqual([]);
  });

  it("returns 404 for an unknown worktree and 401 without a token", async () => {
    const missing = await trpcQuery(
      server.url,
      "reviews.forWorktree",
      { worktreeId: "nope-main" },
      TOKEN,
    );
    expect(missing.status).toBe(404);

    const anonymous = await fetch(
      `${server.url}/trpc/reviews.forWorktree?input=${encodeURIComponent(
        JSON.stringify({ worktreeId: testWorktreeId(REPO, PR_BRANCH) }),
      )}`,
    );
    expect(anonymous.status).toBe(401);
  });

  it("lists the GitHub plugin as active once a github.com repo used it", async () => {
    // Any review lookup on a github.com repo activates the plugin, whether
    // or not gh then answers.
    await forWorktree(server, testWorktreeId(REPO, "main"));

    const res = await trpcQuery(server.url, "plugins.list", undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(await trpcData(res)).toEqual([
      {
        id: "github",
        name: "GitHub",
        version: "0.1.0",
        status: "active",
        error: null,
        slots: [],
      },
    ]);
  });
});

describe("a disabled GitHub plugin", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-pr-checks-disabled-");
    const repo = createRepo(
      tmpHome,
      REPO,
      `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
    );
    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repo,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN, plugins: { disabled: ["github"] } });
    stub = await ghStub.start();
    stub.setReviewQuery(FAKE_REPO, "main", reviewQueryData({}));
    // A worker probes `gh --version` itself when it starts, which this test counts as a call.
    server = await startServer({ tmpHome, env: stub.env, remoteHost: false });
  });

  afterAll(async () => {
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("never activates and never runs gh", async () => {
    expect(await forWorktree(server, testWorktreeId(REPO, "main", false))).toEqual({
      status: "unavailable",
      reason: "no-provider",
      message: "No enabled plugin handles github.com.",
    });

    const res = await trpcQuery(server.url, "plugins.list", undefined, TOKEN);
    expect(await trpcData(res)).toEqual([
      {
        id: "github",
        name: "GitHub",
        version: "0.1.0",
        status: "disabled",
        error: null,
        slots: [],
      },
    ]);
    // `stub.requests` logs every gh call on any route; the enabled suite's
    // first test shows it records the review query.
    expect(stub.requests).toEqual([]);
  });
});
