/**
 * The Checks tab refetches when the hub hears of a change on GitHub, not only on its polling
 * timer: a signed webhook delivery for the worktree's pull request or branch makes the open panel
 * show the new comment or the finished check within seconds, and a delivery for another branch
 * makes no lookup for it.
 *
 * Real server, real repo with a github.com `origin`, `gh` as the Express stub behind
 * `BAND_GH_BIN`, deliveries signed with the secret the hub reads from
 * `BAND_GITHUB_WEBHOOK_SECRET`. Locators live in `pages/PrChecksPanelPage.ts`.
 */

import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
import {
  checkRunNode,
  commentNode,
  FAKE_REPO,
  pullRequestNode,
  reviewQueryData,
} from "../../hub/tests/fixtures/github-review-data";
import { git, gitCommit } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { PrChecksPanelPage } from "./pages/PrChecksPanelPage";

test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-pr-signal-token";
const SECRET = "e2e-pr-signal-secret";
const REPO = "widgets";
const COMMENT_BRANCH = "feat/comment";
const CHECK_BRANCH = "feat/check";
const QUIET_BRANCH = "feat/quiet";
const FULL_NAME = `${FAKE_REPO.owner}/${FAKE_REPO.name}`.toLowerCase();

let tmpHome: string;
let server: ServerHandle;
let stub: GhStub;
let commentAnswer: unknown;
let checkAnswer: unknown;
let quietLookups = 0;
let deliveries = 0;

const commentData = (comments: ReturnType<typeof commentNode>[]) =>
  reviewQueryData({
    pullRequests: [
      pullRequestNode({
        number: 801,
        comments,
        contexts: [checkRunNode({ id: 1, name: "Build", workflow: "CI", runId: 10 })],
      }),
    ],
  });

const checkData = (done: boolean) =>
  reviewQueryData({
    pullRequests: [
      pullRequestNode({
        number: 802,
        contexts: [
          checkRunNode({
            id: 2,
            name: "Release",
            workflow: "Release",
            runId: 20,
            status: done ? "COMPLETED" : "IN_PROGRESS",
            conclusion: done ? "SUCCESS" : null,
            completedAt: done ? "2026-01-01T10:06:03Z" : null,
          }),
        ],
      }),
    ],
  });

async function deliver(event: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await fetch(`${server.url}/api/hooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `signal-${deliveries++}`,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  expect(res.status).toBe(202);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  gitCommit(repo, "init");
  git(repo, ["remote", "add", "origin", `https://github.com/${FULL_NAME}.git`]);
  const worktrees = [COMMENT_BRANCH, CHECK_BRANCH, QUIET_BRANCH].map((branch) => {
    const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
    git(repo, ["worktree", "add", "-b", branch, path]);
    return { name: branch, branch, path };
  });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ name: "main", branch: "main", path: repo }, ...worktrees],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });

  commentAnswer = commentData([]);
  checkAnswer = checkData(false);
  stub = await ghStub.start();
  stub.setReviewQuery(FAKE_REPO, COMMENT_BRANCH, () => commentAnswer);
  stub.setReviewQuery(FAKE_REPO, CHECK_BRANCH, () => checkAnswer);
  stub.setReviewQuery(FAKE_REPO, QUIET_BRANCH, () => {
    quietLookups++;
    return commentData([]);
  });
  server = await startServer({
    tmpHome,
    env: { ...stub.env, BAND_GITHUB_WEBHOOK_SECRET: SECRET },
  });
});

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  cleanupTmpHome(tmpHome);
});

test("a PR comment webhook shows the new comment within seconds", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, COMMENT_BRANCH, "local"));
  await expect(panel.commentItems).toHaveCount(0);

  commentAnswer = commentData([commentNode({ id: "C1", login: "mia", body: "Looks good." })]);
  await deliver("issue_comment", {
    action: "created",
    repository: { full_name: FULL_NAME },
    issue: { number: 801, pull_request: {} },
    comment: { body: "Looks good.", html_url: "https://example.test/c1" },
    sender: { login: "mia" },
  });

  await expect(panel.commentItems).toHaveCount(1, { timeout: 5_000 });
});

test("a completed check_run webhook shows the check's final state within seconds", async ({
  page,
}) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, CHECK_BRANCH, "local"));
  await expect(panel.check("Release")).toHaveAttribute("data-check-state", "running");

  checkAnswer = checkData(true);
  await deliver("check_run", {
    action: "completed",
    repository: { full_name: FULL_NAME },
    check_run: {
      head_branch: CHECK_BRANCH,
      head_sha: "a".repeat(40),
      check_suite: { head_branch: CHECK_BRANCH },
    },
    sender: { login: "github-actions" },
  });

  await expect(panel.check("Release")).toHaveAttribute("data-check-state", "success", {
    timeout: 5_000,
  });
});

test("a webhook for another branch makes no lookup for this worktree", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, QUIET_BRANCH, "local"));
  // The panel's own startup lookups can land after goto returns; take the baseline once they stop.
  let last = -1;
  await expect
    .poll(
      () => {
        const settled = quietLookups === last;
        last = quietLookups;
        return settled;
      },
      { intervals: [500], timeout: 10_000 },
    )
    .toBe(true);
  const before = quietLookups;

  await deliver("check_run", {
    action: "completed",
    repository: { full_name: FULL_NAME },
    check_run: { head_branch: CHECK_BRANCH, head_sha: "b".repeat(40) },
    sender: { login: "github-actions" },
  });
  // A webhook for a different repo too.
  await deliver("check_run", {
    action: "completed",
    repository: { full_name: "other/repo" },
    check_run: { head_branch: QUIET_BRANCH, head_sha: "c".repeat(40) },
    sender: { login: "github-actions" },
  });

  // A delivery for this branch is the control: the panel refetches once for it, which shows
  // the earlier ones, coalesced into the same second, added no lookup of their own.
  await deliver("check_run", {
    action: "completed",
    repository: { full_name: FULL_NAME },
    check_run: { head_branch: QUIET_BRANCH, head_sha: "d".repeat(40) },
    sender: { login: "github-actions" },
  });
  await expect.poll(() => quietLookups, { timeout: 5_000 }).toBeGreaterThan(before);
  expect(quietLookups).toBe(before + 1);
});
