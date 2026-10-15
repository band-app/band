/**
 * End-to-end coverage for the GitHub plugin's Checks tab in the right
 * sidepanel: a branch's pull request with its merge state and checks, links
 * to each job on GitHub, the "Fix" hand-off to a coding agent, merging and a
 * failed merge, refreshing, the live elapsed time of running and queued
 * checks, the GitHub Actions jobs of a branch with no pull
 * request, and what the tab shows when `gh` fails or no plugin serves the
 * repo. `pr-checks-panel-disabled.spec.ts` covers a disabled plugin.
 *
 * Real server, real repos with a github.com `origin`. `gh` is the fake in
 * `tests/fixtures/gh-stub-bin.mjs`, selected through `BAND_GH_BIN` and
 * answered by the Express stub in `tests/fixtures/gh-stub.ts`. Coding agents
 * are the scripted ACP stub. No tRPC mocking, no `page.route`. Locators live
 * in `pages/PrChecksPanelPage.ts`.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { type GhInvocation, type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
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
} from "../../hub/tests/fixtures/github-review-data";
import { acpStubEnv, stubRequests } from "./helpers/acp-stub";
import { git, gitCommit } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";
import { PrChecksPanelPage } from "./pages/PrChecksPanelPage";
import { WorktreePage } from "./pages/WorktreePage";

// Wide viewport so the right sidepanel renders beside the center dockview.
test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-pr-checks-token";
const REPO = "widgets";
const PR_BRANCH = "feat/login";
const READY_BRANCH = "feat/ready";
const MERGE_FAIL_BRANCH = "feat/merge-blocked";
const REFRESH_BRANCH = "feat/refresh";
const GH_DOWN_BRANCH = "feat/gh-down";
const RUNNING_BRANCH = "feat/running";
const DISCUSSION_BRANCH = "feat/discussion";
const FIX_CHAT_BRANCH = "feat/fix-chat";
const FIX_TERM_BRANCH = "feat/fix-term";
const RUNNING_STARTED_AT = "2026-01-01T10:00:00Z";
const MERGE_FAIL_MESSAGE =
  "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge.";

let server: ServerHandle;
let stub: GhStub;
let tmpHome: string;
const merges: GhInvocation[] = [];
// The refresh test swaps this between lookups.
let refreshAnswer: unknown;
// The elapsed-time test swaps this once the running check completes.
let runningAnswer: unknown;

function runningChecks(release: { completedAt: string | null }) {
  return reviewQueryData({
    pullRequests: [
      pullRequestNode({
        number: 710,
        contexts: [
          checkRunNode({
            id: 61,
            name: "Release",
            workflow: "Release",
            runId: 1000,
            status: release.completedAt ? "COMPLETED" : "IN_PROGRESS",
            conclusion: release.completedAt ? "SUCCESS" : null,
            startedAt: RUNNING_STARTED_AT,
            completedAt: release.completedAt,
          }),
          checkRunNode({
            id: 62,
            name: "Deploy",
            workflow: "Release",
            runId: 1000,
            status: "QUEUED",
            conclusion: null,
            startedAt: null,
            completedAt: null,
          }),
        ],
      }),
    ],
  });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  gitCommit(repo, "init");
  git(repo, [
    "remote",
    "add",
    "origin",
    `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
  ]);
  const prWorktree = join(tmpHome, "wt-login");
  git(repo, ["worktree", "add", "-b", PR_BRANCH, prWorktree]);
  const readyWorktree = join(tmpHome, "wt-ready");
  git(repo, ["worktree", "add", "-b", READY_BRANCH, readyWorktree]);
  const worktrees = [
    MERGE_FAIL_BRANCH,
    REFRESH_BRANCH,
    GH_DOWN_BRANCH,
    RUNNING_BRANCH,
    DISCUSSION_BRANCH,
    FIX_CHAT_BRANCH,
    FIX_TERM_BRANCH,
  ].map((branch) => {
    const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
    git(repo, ["worktree", "add", "-b", branch, path]);
    return { name: branch, branch, path };
  });
  // The file an inline thread points at, untracked but on disk in its worktree.
  const discussionPath = join(tmpHome, `wt-${DISCUSSION_BRANCH.replaceAll("/", "-")}`);
  mkdirSync(join(discussionPath, "src"), { recursive: true });
  writeFileSync(
    join(discussionPath, "src", "login.ts"),
    Array.from({ length: 60 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n"),
  );
  const localOnly = join(tmpHome, "local-only");
  mkdirSync(localOnly, { recursive: true });
  git(localOnly, ["init", "-b", "main"]);
  gitCommit(localOnly, "init");

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [
          { name: "main", branch: "main", path: repo },
          { name: PR_BRANCH, branch: PR_BRANCH, path: prWorktree },
          { name: READY_BRANCH, branch: READY_BRANCH, path: readyWorktree },
          ...worktrees,
        ],
      },
      {
        name: "local-only",
        path: localOnly,
        defaultBranch: "main",
        worktrees: [{ name: "main", branch: "main", path: localOnly }],
      },
    ],
  });
  // The agent's CLI for a device in terminal mode: prints its prompt argument and stays running.
  const agentCli = join(tmpHome, "stub-claude.sh");
  writeFileSync(agentCli, '#!/bin/sh\necho "FIX_AGENT_STARTED $*"\nexec sleep 600\n');
  chmodSync(agentCli, 0o755);
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: agentCli },
    ],
    defaultCodingAgent: "claude-code",
    useWebGLTerminalRenderer: false,
  });

  stub = await ghStub.start();
  stub.setReviewQuery(
    FAKE_REPO,
    PR_BRANCH,
    reviewQueryData({
      pullRequests: [
        pullRequestNode({
          number: 697,
          title: "fix(web): pad the top inset in the wide layout",
          mergeStateStatus: "BLOCKED",
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
          ],
        }),
      ],
    }),
  );
  stub.setReviewQuery(
    FAKE_REPO,
    READY_BRANCH,
    reviewQueryData({
      pullRequests: [
        pullRequestNode({
          number: 700,
          mergeStateStatus: "CLEAN",
          contexts: [checkRunNode({ id: 31, name: "Build", workflow: "CI", runId: 800 })],
        }),
      ],
    }),
  );
  for (const [branch, number] of [
    [FIX_CHAT_BRANCH, 720],
    [FIX_TERM_BRANCH, 721],
  ] as const) {
    stub.setReviewQuery(
      FAKE_REPO,
      branch,
      reviewQueryData({
        pullRequests: [
          pullRequestNode({
            number,
            contexts: [
              checkRunNode({
                id: number,
                name: "Lint",
                workflow: "CI",
                runId: 900 + number,
                conclusion: "FAILURE",
              }),
            ],
          }),
        ],
      }),
    );
  }
  stub.setPrMerge(700, { onRequest: (r) => merges.push(r) });
  stub.setReviewQuery(
    FAKE_REPO,
    MERGE_FAIL_BRANCH,
    reviewQueryData({ pullRequests: [pullRequestNode({ number: 702 })] }),
  );
  stub.setPrMerge(702, { stderr: `${MERGE_FAIL_MESSAGE}\n` });
  refreshAnswer = reviewQueryData({
    pullRequests: [
      pullRequestNode({
        number: 703,
        contexts: [checkRunNode({ id: 51, name: "Build", workflow: "CI", runId: 950 })],
      }),
    ],
  });
  stub.setReviewQuery(FAKE_REPO, REFRESH_BRANCH, () => refreshAnswer);
  runningAnswer = runningChecks({ completedAt: null });
  stub.setReviewQuery(FAKE_REPO, RUNNING_BRANCH, () => runningAnswer);
  stub.setReviewQuery(
    FAKE_REPO,
    DISCUSSION_BRANCH,
    reviewQueryData({
      pullRequests: [
        pullRequestNode({
          number: 720,
          reviewRequests: [reviewRequestNode("carol")],
          reviews: [
            reviewNode({
              id: "R1",
              login: "bob",
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-01-02T08:00:00Z",
            }),
            reviewNode({
              id: "R2",
              login: "bob",
              state: "APPROVED",
              submittedAt: "2026-01-02T10:00:00Z",
              body: "Ship it.",
            }),
          ],
          comments: [
            commentNode({
              id: "C1",
              login: "alice",
              body: "This **looks** good.\n\n<script>alert(1)</script>",
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
                  body: "Why not a `const`?",
                  createdAt: "2026-01-02T09:00:00Z",
                }),
                commentNode({
                  id: "TC2",
                  login: "alice",
                  body: "Done in the next commit.",
                  createdAt: "2026-01-02T09:05:00Z",
                }),
              ],
            }),
            reviewThreadNode({
              id: "T2",
              path: "src/resolved.ts",
              line: 7,
              isResolved: true,
              comments: [commentNode({ id: "TC3", login: "bob", body: "Fixed nit." })],
            }),
            reviewThreadNode({
              id: "T3",
              path: "src/outdated.ts",
              line: 9,
              isOutdated: true,
              comments: [commentNode({ id: "TC4", login: "bob", body: "Old remark." })],
            }),
          ],
          contexts: [checkRunNode({ id: 71, name: "Build", workflow: "CI", runId: 1100 })],
        }),
      ],
    }),
  );
  stub.setReviewQueryError(FAKE_REPO, GH_DOWN_BRANCH, "HTTP 401: Bad credentials\n");
  stub.setReviewQuery(
    FAKE_REPO,
    "main",
    reviewQueryData({
      headOid: "4444444444444444444444444444444444444444",
      suites: [
        checkSuiteNode("Release", [
          checkRunNode({ id: 41, name: "Publish", runId: 900 }),
          checkRunNode({ id: 42, name: "Notarize", runId: 900, conclusion: "FAILURE" }),
        ]),
      ],
    }),
  );

  server = await startServer({ tmpHome, env: { ...stub.env, ...acpStubEnv(tmpHome) } });
});

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  cleanupTmpHome(tmpHome);
});

test("shows the pull request, its merge state and each check linking to its job", async ({
  page,
}) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, PR_BRANCH, "local"));

  await expect(panel.number).toHaveText("#697");
  await expect(panel.state).toHaveAttribute("data-review-state", "open");
  await expect(panel.title).toHaveText("fix(web): pad the top inset in the wide layout");
  await expect(panel.updated).toBeVisible();
  await expect(panel.mergeButton).toHaveAttribute("data-merge-state", "blocked");
  await expect(panel.mergeButton).toBeDisabled();

  await expect(panel.failingBanner).toBeVisible();
  await expect(panel.failingCount).toHaveAttribute("data-count", "1");
  await expect(panel.summaryPassing).toHaveAttribute("data-count", "1");
  await expect(panel.summaryFailing).toHaveAttribute("data-count", "1");
  await expect(panel.summaryPending).toHaveAttribute("data-count", "1");

  // Failing first, then running, passing and skipped, as in the mock.
  await expect(panel.checkNames).toHaveText([
    "Claude review",
    "Lint, Test & Build",
    "Detect CLI-relevant changes",
    "CLI Integration Tests (macOS)",
  ]);
  await expect(panel.check("Claude review")).toHaveAttribute("data-check-state", "failure");
  await expect(panel.check("Lint, Test & Build")).toHaveAttribute("data-check-state", "running");
  await expect(panel.check("Detect CLI-relevant changes")).toHaveAttribute(
    "data-check-state",
    "success",
  );
  await expect(panel.check("CLI Integration Tests (macOS)")).toHaveAttribute(
    "data-check-state",
    "skipped",
  );

  await expect(panel.checkLink("Claude review")).toHaveAttribute("href", jobUrl(501, 12));
  await expect(panel.checkLink("Lint, Test & Build")).toHaveAttribute("href", jobUrl(500, 13));
  await expect(panel.checkLink("Detect CLI-relevant changes")).toHaveAttribute(
    "href",
    jobUrl(500, 11),
  );
  await expect(panel.checkLink("CLI Integration Tests (macOS)")).toHaveAttribute(
    "href",
    jobUrl(500, 14),
  );

  await panel.expandCheck("Claude review");
  await expect(panel.checkDetails("Claude review")).toContainText("Review");
  await expect(panel.checkDetails("Claude review")).toContainText("2 issues found");
});

test("Fix starts a coding agent with the failing checks and their job links", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, PR_BRANCH, "local"));
  await worktree.setDeviceAgentMode("gui");
  await expect(panel.failingBanner).toBeVisible();

  await panel.startFix();

  await expect.poll(() => stubRequests(tmpHome, "session/prompt")).toHaveLength(1);
  const prompt = JSON.stringify(stubRequests(tmpHome, "session/prompt")[0].params);
  expect(prompt).toContain(`Review / Claude review: ${jobUrl(501, 12)}`);
  expect(prompt).toContain("pull request #697");
  // Only the failing check goes to the agent.
  expect(prompt).not.toContain(jobUrl(500, 13));
});

test("Fix opens the agent as the active chat tab, and Open returns to it", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, FIX_CHAT_BRANCH, "local"));
  await worktree.setDeviceAgentMode("gui");
  await expect(worktree.chatTabs()).toHaveCount(0);

  await panel.startFix();

  await expect(worktree.chatTabs()).toHaveCount(1);
  await expect(worktree.activeTab("chat")).toHaveCount(1);
  await expect(new ChatPanePage(page, server.url, TOKEN).userMessage("Lint")).toBeVisible();
  await expect(panel.openAgentLink).toBeVisible();

  // Switch to the terminal tab, then use the banner's Open.
  await worktree.tab("terminal").click();
  await expect(worktree.activeTab("chat")).toHaveCount(0);
  await panel.openFixAgent();
  await expect(worktree.activeTab("chat")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("fix-chat-tab.png") });
});

test("Fix opens the agent as the active terminal tab in terminal mode", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const id = toWorktreeId(REPO, FIX_TERM_BRANCH, "local");
  await panel.goto(id);
  await worktree.setDeviceAgentMode("tui");
  await expect(worktree.terminalTabs()).toHaveCount(1);
  const originalTab = (await worktree.terminalTabs().first().getAttribute("data-testid")) ?? "";

  await panel.startFix();

  await expect(worktree.terminalTabs()).toHaveCount(2);
  await expect
    .poll(() => worktree.readTerminalRenderedText(id), { timeout: 15_000 })
    .toContain("FIX_AGENT_STARTED");
  // The new terminal is the active tab, not the one that was open before.
  await expect(worktree.activeTab("terminal")).toHaveCount(1);
  await expect(worktree.activeTab("terminal").getByTestId(originalTab)).toHaveCount(0);
});

test("merging from the menu runs gh pr merge with the chosen method", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, READY_BRANCH, "local"));
  await expect(panel.number).toHaveText("#700");
  await expect(panel.mergeButton).toBeEnabled();

  await panel.merge("rebase");

  await expect
    .poll(() => merges.map((m) => m.args))
    .toEqual([["pr", "merge", "700", "--rebase", "--repo", "github.com/acme/widgets"]]);
});

test("a branch without a pull request lists its GitHub Actions jobs", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, "main", "local"));

  await expect(panel.branch).toHaveText("main");
  await expect(panel.noReview).toContainText("4444444");
  await expect(panel.number).toHaveCount(0);
  await expect(panel.checkNames).toHaveText(["Notarize", "Publish"]);
  await expect(panel.check("Notarize")).toHaveAttribute("data-check-state", "failure");
  await expect(panel.checkLink("Notarize")).toHaveAttribute("href", jobUrl(900, 42));
  await expect(panel.checkLink("Publish")).toHaveAttribute("href", jobUrl(900, 41));
});

test("a failed merge shows gh's message", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, MERGE_FAIL_BRANCH, "local"));
  await expect(panel.number).toHaveText("#702");

  await panel.merge("merge");

  await expect(panel.mergeError).toHaveText(MERGE_FAIL_MESSAGE);
});

test("Refresh runs the lookup again and shows the new checks", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, REFRESH_BRANCH, "local"));
  await expect(panel.checkNames).toHaveText(["Build"]);

  refreshAnswer = reviewQueryData({
    pullRequests: [
      pullRequestNode({
        number: 703,
        contexts: [
          checkRunNode({ id: 51, name: "Build", workflow: "CI", runId: 950 }),
          checkRunNode({ id: 52, name: "Deploy", workflow: "CI", runId: 950 }),
        ],
      }),
    ],
  });
  await panel.refresh();

  await expect(panel.checkNames).toHaveText(["Build", "Deploy"]);
});

test("a running check counts up from its start time and a queued one says so", async ({ page }) => {
  runningAnswer = runningChecks({ completedAt: null });
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.setTime("2026-01-01T10:04:12Z");
  await panel.goto(toWorktreeId(REPO, RUNNING_BRANCH, "local"));

  await panel.expandCheck("Release");
  await expect(panel.checkDuration("Release")).toHaveText("Running for 4m 12s");
  await panel.expandCheck("Deploy");
  await expect(panel.checkDuration("Deploy")).toHaveText("Queued");

  // No refetch in between: the panel's own tick picks up the new time.
  await panel.setTime("2026-01-01T10:05:30Z");
  await expect(panel.checkDuration("Release")).toHaveText("Running for 5m 30s");

  runningAnswer = runningChecks({ completedAt: "2026-01-01T10:06:03Z" });
  await panel.refresh();
  await expect(panel.check("Release")).toHaveAttribute("data-check-state", "success");
  await expect(panel.checkDuration("Release")).toHaveText("6m 3s");
});

test("the summary row collapses and expands the check list", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, PR_BRANCH, "local"));
  await expect(panel.list).toBeVisible();

  await panel.toggleSummary();
  await expect(panel.summary).toHaveAttribute("aria-expanded", "false");
  await expect(panel.list).toBeHidden();

  await panel.toggleSummary();
  await expect(panel.summary).toHaveAttribute("aria-expanded", "true");
  await expect(panel.list).toBeVisible();
});

test("the overflow menu offers opening and copying the pull request link", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, PR_BRANCH, "local"));
  await expect(panel.number).toHaveText("#697");

  await panel.openMenu();

  await expect(panel.menuOpenItem).toBeVisible();
  await expect(panel.menuCopyItem).toBeVisible();
});

test("a gh failure shows the error with a retry button", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, GH_DOWN_BRANCH, "local"));

  await expect(panel.error).toContainText("HTTP 401: Bad credentials");
  await expect(panel.errorRetry).toBeVisible();
  await expect(panel.root).toHaveCount(0);
});

test("a repo without an origin remote shows why the tab is empty", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId("local-only", "main", "local"));

  await expect(panel.unavailable).toBeVisible();
  await expect(panel.root).toHaveCount(0);
});

test("the Reviewers section lists each reviewer's latest state above Checks", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, DISCUSSION_BRANCH, "local"));

  await expect(panel.reviewersSummary).toHaveText("1/2 approved");
  await expect(panel.reviewers).toHaveCount(2);
  // bob requested changes and later approved: only Approved shows.
  await expect(panel.reviewer("bob")).toHaveAttribute("data-reviewer-state", "approved");
  await expect(panel.reviewer("carol")).toHaveAttribute("data-reviewer-state", "pending");

  const reviewersTop = (await panel.sectionHeader("reviewers").boundingBox())?.y ?? 0;
  const checksTop = (await panel.sectionHeader("checks").boundingBox())?.y ?? 0;
  const commentsTop = (await panel.sectionHeader("comments").boundingBox())?.y ?? 0;
  expect(reviewersTop).toBeLessThan(checksTop);
  expect(checksTop).toBeLessThan(commentsTop);
});

test("the Comments section shows comments, review summaries and inline threads", async ({
  page,
}) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, DISCUSSION_BRANCH, "local"));

  // One comment, one review summary and three threads; two are unresolved.
  await expect(panel.commentsSummary).toHaveText("5, 2 unresolved");
  await expect(panel.commentItems).toHaveCount(2);
  await expect(panel.commentItems.first()).toContainText("alice");
  // Markdown is rendered: the emphasis markers are gone from the text.
  await expect(panel.commentItems.first()).toContainText("This looks good.");
  await expect(panel.commentItems.first()).not.toContainText("**");
  // Untrusted HTML in a body is not rendered as markup.
  await expect(panel.commentBodyScripts()).toHaveCount(0);
  await expect(panel.commentItems.nth(1)).toContainText("Ship it.");

  const thread = panel.thread("src/login.ts:42");
  await expect(thread).toContainText("Why not a");
  await expect(thread).toContainText("Done in the next commit.");
  await expect(panel.threadLinks("src/login.ts:42")).toHaveCount(2);
});

test("resolved and outdated threads start collapsed and expand on click", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, DISCUSSION_BRANCH, "local"));

  const resolved = "src/resolved.ts:7";
  const outdated = "src/outdated.ts:9";
  await expect(panel.threadLabel(resolved)).toHaveText("Resolved");
  await expect(panel.threadLabel(outdated)).toHaveText("Outdated");
  await expect(panel.threadMessages(resolved)).toBeHidden();
  await expect(panel.threadMessages(outdated)).toBeHidden();

  await panel.toggleThread("src/resolved.ts:7");
  await expect(panel.threadMessages(resolved)).toContainText("Fixed nit.");
  await expect(panel.threadMessages(outdated)).toBeHidden();
});

test("clicking a thread's path:line opens that file in Band", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, DISCUSSION_BRANCH, "local"));

  await panel.openThreadLocation("src/login.ts:42");

  await expect(worktree.fileTab("src/login.ts")).toBeVisible();
});

test("each section keeps its own collapsed state across a reload", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  const worktreeId = toWorktreeId(REPO, DISCUSSION_BRANCH, "local");
  await panel.goto(worktreeId);

  // Everything starts expanded.
  for (const id of ["reviewers", "checks", "comments"] as const) {
    await expect(panel.sectionHeader(id)).toHaveAttribute("aria-expanded", "true");
  }

  await panel.toggleSection("reviewers");
  await panel.toggleSection("comments");
  await expect(panel.reviewers.first()).toBeHidden();
  await expect(panel.commentItems.first()).toBeHidden();
  await expect(panel.list).toBeVisible();

  await page.reload();
  await panel.goto(worktreeId);

  await expect(panel.sectionHeader("reviewers")).toHaveAttribute("aria-expanded", "false");
  await expect(panel.sectionHeader("comments")).toHaveAttribute("aria-expanded", "false");
  await expect(panel.sectionHeader("checks")).toHaveAttribute("aria-expanded", "true");
});

test("a branch with no pull request shows only the checks", async ({ page }) => {
  const panel = new PrChecksPanelPage(page, server.url, TOKEN);
  await panel.goto(toWorktreeId(REPO, "main", "local"));

  await expect(panel.reviewersSummary).toHaveCount(0);
  await expect(panel.commentsSummary).toHaveCount(0);
  await expect(panel.checks).not.toHaveCount(0);
});
