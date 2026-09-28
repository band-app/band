/**
 * The PR badge in a sidebar workspace row: the PR number colored by CI state,
 * the popover it opens on hover and on keyboard focus (number, title,
 * status, "Open on GitHub", "Copy link"), and clicking it to show that
 * workspace's Checks tab.
 *
 * Real server, a real repo with a github.com `origin`. `gh` is the fake in
 * `tests/fixtures/gh-stub-bin.mjs`, selected through `BAND_GH_BIN` and
 * answered by the Express stub in `tests/fixtures/gh-stub.ts`: the
 * branch-status poller's batched query feeds the badges, the GitHub plugin's
 * review query feeds the Checks tab. The popup's github.com page is answered
 * by `context.route`, since GitHub is an external site. No tRPC mocking.
 * Locators live in `pages/PullRequestBadgePage.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  branchRepository,
  prNode,
  prUrl,
  workflowSuite,
} from "../tests/fixtures/branch-status-data";
import { type GhStub, ghStub } from "../tests/fixtures/gh-stub";
import {
  checkRunNode,
  FAKE_REPO,
  pullRequestNode,
  reviewQueryData,
} from "../tests/fixtures/github-review-data";
import { acpStubEnv } from "./helpers/acp-stub";
import { git, gitCommit } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { PrChecksPanelPage } from "./pages/PrChecksPanelPage";
import { PullRequestBadgePage } from "./pages/PullRequestBadgePage";

// Wide viewport so the right sidepanel renders beside the center dockview.
test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-pr-badge-token";
const PROJECT = "widgets";
const FAILING = "feat/failing";
const DRAFT = "feat/draft";
const PASSING = "feat/passing";
const MERGED = "feat/merged";
const NO_PR = "feat/no-pr";
const FAILING_TITLE = "fix(web): stop terminal input stalls";

const wsId = (branch: string) => toWorkspaceId(PROJECT, branch);

let server: ServerHandle;
let stub: GhStub;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
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
  const worktrees = [FAILING, DRAFT, PASSING, MERGED, NO_PR].map((branch) => {
    const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
    git(repo, ["worktree", "add", "-b", branch, path]);
    return { name: branch, branch, path };
  });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ name: "main", branch: "main", path: repo }, ...worktrees],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  stub = await ghStub.start();
  const repositories: Record<string, ReturnType<typeof branchRepository>> = {
    [FAILING]: branchRepository({
      pullRequests: [prNode({ number: 705, title: FAILING_TITLE })],
      suites: [workflowSuite({ workflow: "CI", conclusion: "FAILURE" })],
    }),
    [DRAFT]: branchRepository({
      pullRequests: [prNode({ number: 706, title: "wip: the badge", isDraft: true })],
      suites: [workflowSuite({ workflow: "CI", status: "IN_PROGRESS" })],
    }),
    [PASSING]: branchRepository({
      pullRequests: [prNode({ number: 707 })],
      suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
    }),
    [MERGED]: branchRepository({
      pullRequests: [prNode({ number: 700, state: "MERGED" })],
    }),
    [NO_PR]: branchRepository({
      suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
    }),
  };
  stub.setBranchStatusQuery(FAKE_REPO, (branch) => repositories[branch]);
  stub.setReviewQuery(
    FAKE_REPO,
    FAILING,
    reviewQueryData({
      pullRequests: [
        pullRequestNode({
          number: 705,
          title: FAILING_TITLE,
          contexts: [checkRunNode({ id: 1, name: "Lint", conclusion: "FAILURE" })],
        }),
      ],
    }),
  );

  server = await startServer({ tmpHome, env: { ...stub.env, ...acpStubEnv(tmpHome) } });
});

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test.beforeEach(() => {
  resetClientState(tmpHome);
});

test("a workspace with a PR shows its number, colored by CI state", async ({ page }) => {
  const badges = new PullRequestBadgePage(page, server.url, TOKEN);
  await badges.goto(wsId("main"));

  await expect(badges.badge(wsId(FAILING))).toHaveText("#705");
  await expect(badges.badge(wsId(FAILING))).toHaveAttribute("data-tone", "failure");
  await expect(badges.badge(wsId(DRAFT))).toHaveText("#706");
  await expect(badges.badge(wsId(DRAFT))).toHaveAttribute("data-tone", "pending");
  await expect(badges.badge(wsId(PASSING))).toHaveText("#707");
  await expect(badges.badge(wsId(PASSING))).toHaveAttribute("data-tone", "success");
  await expect(badges.badge(wsId(MERGED))).toHaveText("#700");
  await expect(badges.badge(wsId(MERGED))).toHaveAttribute("data-tone", "merged");

  // Red, yellow and green render as three different colors.
  const colors = new Set([
    await badges.badgeColor(wsId(FAILING)),
    await badges.badgeColor(wsId(DRAFT)),
    await badges.badgeColor(wsId(PASSING)),
  ]);
  expect(colors.size).toBe(3);

  // No PR, no badge; neither on the default branch.
  await expect(badges.badge(wsId(NO_PR))).toHaveCount(0);
  await expect(badges.badge(wsId("main"))).toHaveCount(0);
});

test("hovering the badge shows the PR's number, title and status", async ({ page }) => {
  const badges = new PullRequestBadgePage(page, server.url, TOKEN);
  await badges.goto(wsId("main"));

  await badges.hoverBadge(wsId(FAILING));
  await expect(badges.popoverNumber).toHaveText("#705");
  await expect(badges.popoverTitle).toHaveText(FAILING_TITLE);
  await expect(badges.popoverStatus).toHaveText("Checks failing");
  await expect(badges.popoverDraft).toHaveCount(0);

  await badges.moveMouseAway();
  await expect(badges.popover).toHaveCount(0);

  await badges.hoverBadge(wsId(DRAFT));
  await expect(badges.popoverNumber).toHaveText("#706");
  await expect(badges.popoverStatus).toHaveText("Checks running");
  await expect(badges.popoverDraft).toBeVisible();
});

test("the popover opens on keyboard focus and its copy action copies the PR link", async ({
  page,
}) => {
  const badges = new PullRequestBadgePage(page, server.url, TOKEN);
  await badges.workspace.installClipboardCapture();
  await badges.goto(wsId("main"));

  await badges.focusBadgeWithKeyboard(wsId(FAILING));
  await expect(badges.popover).toBeVisible();
  await expect(badges.popoverTitle).toHaveText(FAILING_TITLE);

  // ArrowDown moves into the popover; Tab reaches the copy action.
  await badges.pressKey("ArrowDown");
  await expect(badges.openButton).toBeFocused();
  await badges.pressKey("Tab");
  await expect(badges.copyButton).toBeFocused();
  await badges.pressKey("Enter");
  await expect.poll(() => badges.workspace.readCopied()).toEqual([prUrl(705)]);
  await expect(badges.copyButton).toHaveText("Copied");

  // Escape closes the popover and returns focus to the badge.
  await badges.pressKey("Escape");
  await expect(badges.popover).toHaveCount(0);
  await expect(badges.badge(wsId(FAILING))).toBeFocused();
});

test("Open on GitHub opens the PR's page", async ({ page, context }) => {
  await context.route("https://github.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>GitHub</title>" }),
  );
  const badges = new PullRequestBadgePage(page, server.url, TOKEN);
  await badges.goto(wsId("main"));

  await badges.hoverBadge(wsId(FAILING));
  const popup = await badges.openOnGitHub();
  await popup.waitForURL(prUrl(705));
  await expect(badges.popover).toHaveCount(0);
});

test("clicking the badge opens that workspace's Checks tab", async ({ page }) => {
  const badges = new PullRequestBadgePage(page, server.url, TOKEN);
  const checks = new PrChecksPanelPage(page, server.url, TOKEN);
  await badges.goto(wsId("main"));
  await expect(badges.workspace.rightPanelTab("explorer")).toHaveAttribute("aria-selected", "true");

  await badges.clickBadge(wsId(FAILING));

  await expect(badges.workspace.workspaceCard(wsId(FAILING))).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(badges.workspace.rightPanel).toHaveAttribute("data-visible", "true");
  await expect(badges.workspace.rightPanelTab("github-pull-request")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(checks.number).toHaveText("#705");
});
