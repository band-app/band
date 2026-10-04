/**
 * The review panel's backend: `reviews.forWorkspace` and `reviews.merge`,
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
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GhInvocation, type GhStub, ghStub } from "./fixtures/gh-stub";
import {
  checkRunNode,
  checkSuiteNode,
  FAKE_REPO,
  jobUrl,
  pullRequestNode,
  reviewQueryData,
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

const TOKEN = "pr-checks-test-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

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

async function forWorkspace(server: ServerHandle, workspaceId: string) {
  const res = await trpcQuery(server.url, "reviews.forWorkspace", { workspaceId }, TOKEN);
  expect(res.status).toBe(200);
  return trpcData<Record<string, unknown>>(res);
}

const PROJECT = "widgets";
const PR_BRANCH = "feat/login";
const BRANCH_ONLY = "feat/no-pr";
const FAILING_BRANCH = "feat/gh-down";
const MERGE_BRANCH = "feat/merge-me";
const MERGE_FAIL_BRANCH = "feat/merge-blocked";

describe("reviews.forWorkspace and reviews.merge (GitHub plugin)", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  let prWorktree: string;
  let mergeWorktree: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-pr-checks-");
    const repo = createRepo(
      tmpHome,
      PROJECT,
      `git@github.com:${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
    );
    prWorktree = addWorktree(repo, tmpHome, PR_BRANCH);
    const branchOnlyWorktree = addWorktree(repo, tmpHome, BRANCH_ONLY);
    const failingWorktree = addWorktree(repo, tmpHome, FAILING_BRANCH);
    mergeWorktree = addWorktree(repo, tmpHome, MERGE_BRANCH);
    const mergeFailWorktree = addWorktree(repo, tmpHome, MERGE_FAIL_BRANCH);
    const noRemote = createRepo(tmpHome, "local-only", null);
    const gitlab = createRepo(tmpHome, "on-gitlab", "https://gitlab.com/acme/widgets.git");

    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: repo,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repo },
            { name: PR_BRANCH, branch: PR_BRANCH, path: prWorktree },
            { name: BRANCH_ONLY, branch: BRANCH_ONLY, path: branchOnlyWorktree },
            { name: FAILING_BRANCH, branch: FAILING_BRANCH, path: failingWorktree },
            { name: MERGE_BRANCH, branch: MERGE_BRANCH, path: mergeWorktree },
            { name: MERGE_FAIL_BRANCH, branch: MERGE_FAIL_BRANCH, path: mergeFailWorktree },
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

    const data = await forWorkspace(server, toWorkspaceId(PROJECT, PR_BRANCH));

    expect(data).toEqual({
      status: "ok",
      provider: { id: "github", name: "GitHub" },
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
      },
      checks: expectedChecks,
      fetchedAt: expect.any(String),
    });

    // One `gh api graphql` call per lookup, against github.com (no
    // --hostname), run in the workspace's worktree with prompts disabled.
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
    expect(requests[0].cwd).toBe(prWorktree);
    expect(requests[0].env).toEqual({ GH_PROMPT_DISABLED: "1" });
    expect(stub.requests).toContainEqual(requests[0]);
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

    const data = await forWorkspace(server, toWorkspaceId(PROJECT, BRANCH_ONLY));

    expect(data).toEqual({
      status: "ok",
      provider: { id: "github", name: "GitHub" },
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

    const data = await forWorkspace(server, toWorkspaceId(PROJECT, "main"));

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

    const data = await forWorkspace(server, toWorkspaceId(PROJECT, FAILING_BRANCH));

    expect(data).toEqual({ status: "error", message: "HTTP 401: Bad credentials" });
  });

  it("reports projects the plugin can't serve as unavailable", async () => {
    expect(await forWorkspace(server, toWorkspaceId("local-only", "main"))).toEqual({
      status: "unavailable",
      reason: "no-remote",
      message: "The project has no origin remote.",
    });
    expect(await forWorkspace(server, toWorkspaceId("on-gitlab", "main"))).toEqual({
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
      { workspaceId: toWorkspaceId(PROJECT, MERGE_BRANCH), method: "squash" },
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
        cwd: mergeWorktree,
        env: { GH_PROMPT_DISABLED: "1" },
      },
    ]);
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
      { workspaceId: toWorkspaceId(PROJECT, MERGE_FAIL_BRANCH), method: "merge" },
      TOKEN,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge.",
    );
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
      { workspaceId: toWorkspaceId(PROJECT, BRANCH_ONLY), method: "merge" },
      TOKEN,
    );

    expect(res.status).toBe(412);
    expect(merges).toEqual([]);
  });

  it("returns 404 for an unknown workspace and 401 without a token", async () => {
    const missing = await trpcQuery(
      server.url,
      "reviews.forWorkspace",
      { workspaceId: "nope-main" },
      TOKEN,
    );
    expect(missing.status).toBe(404);

    const anonymous = await fetch(
      `${server.url}/trpc/reviews.forWorkspace?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: toWorkspaceId(PROJECT, PR_BRANCH) }),
      )}`,
    );
    expect(anonymous.status).toBe(401);
  });

  it("lists the GitHub plugin as active once a github.com project used it", async () => {
    // Any review lookup on a github.com project activates the plugin, whether
    // or not gh then answers.
    await forWorkspace(server, toWorkspaceId(PROJECT, "main"));

    const res = await trpcQuery(server.url, "plugins.list", undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(await trpcData(res)).toEqual([
      {
        id: "github",
        name: "GitHub",
        version: "0.1.0",
        status: "active",
        error: null,
        slots: ["workspace.sideTabs"],
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
      PROJECT,
      `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
    );
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
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
    expect(await forWorkspace(server, toWorkspaceId(PROJECT, "main"))).toEqual({
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
        slots: ["workspace.sideTabs"],
      },
    ]);
    // `stub.requests` logs every gh call on any route; the enabled suite's
    // first test shows it records the review query.
    expect(stub.requests).toEqual([]);
  });
});
