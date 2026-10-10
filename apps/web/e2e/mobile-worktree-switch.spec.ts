/**
 * Switching worktrees on a phone keeps every visited worktree mounted, the
 * way the desktop layout does (`MobileWorktreeShell` hosts the center
 * dockviews in a `MultiWorktreePanelHost`). Before, the mobile layout was
 * keyed by worktree, so each switch unmounted the chat, and coming back
 * replayed its whole event log.
 *
 * Also covers the mobile header: the worktree label on two rows (worktree
 * over repo, the Pinned section's `WorktreeLabel`), the repo-list
 * fly-out's top row as tall as the header, and the GitHub plugin's Checks tab
 * as a row in the header's panel menu and a sheet, opened by the PR badge
 * too. A sheet opened in one worktree doesn't carry over to the next.
 *
 * Proof of "not remounted": a mark set on the worktree's mounted entry
 * survives the round trip, the chat still shows its messages, and the page
 * opened no second event stream without a `lastEventId` cursor.
 *
 * Real server, real git worktrees with a github.com `origin`. `gh` is the
 * fake in `tests/fixtures/gh-stub-bin.mjs` behind the Express stub in
 * `tests/fixtures/gh-stub.ts`; the coding agent is the scripted ACP stub. No
 * tRPC mocking, no `page.route`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  branchRepository,
  prNode,
  workflowSuite,
} from "../../hub/tests/fixtures/branch-status-data";
import { type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
import {
  checkRunNode,
  FAKE_REPO,
  pullRequestNode,
  reviewQueryData,
} from "../../hub/tests/fixtures/github-review-data";
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
import { ChatPanePage } from "./pages/ChatPanePage";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";
import { PrChecksPanelPage } from "./pages/PrChecksPanelPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-mobile-worktree-switch-token";
const REPO = "mobile-switch";
const ALPHA = "feat/alpha";
const BETA = "feat/beta";
const WS_ALPHA = toWorktreeId(REPO, ALPHA);
const WS_BETA = toWorktreeId(REPO, BETA);
const CHECKS = "github-pull-request";

test.use({ viewport: { width: 390, height: 844 } });

let server: ServerHandle;
let stub: GhStub;
let tmpHome: string;

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
  const worktrees = [ALPHA, BETA].map((branch) => {
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
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  stub = await ghStub.start();
  const repositories: Record<string, ReturnType<typeof branchRepository>> = {
    [ALPHA]: branchRepository({
      pullRequests: [prNode({ number: 801 })],
      suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
    }),
    [BETA]: branchRepository({
      pullRequests: [prNode({ number: 802 })],
      suites: [workflowSuite({ workflow: "CI", conclusion: "FAILURE" })],
    }),
  };
  stub.setBranchStatusQuery(FAKE_REPO, (branch) => repositories[branch]);
  for (const [branch, number] of [
    [ALPHA, 801],
    [BETA, 802],
  ] as const) {
    stub.setReviewQuery(
      FAKE_REPO,
      branch,
      reviewQueryData({
        pullRequests: [
          pullRequestNode({
            number,
            contexts: [checkRunNode({ id: number, name: "Lint", conclusion: "SUCCESS" })],
          }),
        ],
      }),
    );
  }

  server = await startServer({ tmpHome, env: { ...stub.env, ...acpStubEnv(tmpHome) } });
});

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test.beforeEach(() => resetClientState(tmpHome));

test("switching away and back does not remount the chat or replay its messages", async ({
  page,
}) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  const layout = new MobileLayoutPage(page, server.url, TOKEN);
  const fullReplays = chat.trackFullReplays();

  await chat.goto(WS_ALPHA);
  await chat.waitForReady();
  await chat.typeMessage("remember me");
  await chat.submit();
  await expect(chat.assistantMessage('Heard "remember me"')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => fullReplays().length).toBe(1);
  await worktree.markMountedWorktree(WS_ALPHA);

  // The header shows the worktree over its repo, centered.
  await expect(layout.headerWorktreeName).toHaveText(ALPHA);
  await expect(layout.headerRepoName).toHaveText(REPO);
  const header = await layout.readLayout(layout.header);
  const label = await layout.readLayout(layout.headerLabel);
  expect(Math.abs((label.left + label.right) / 2 - (header.left + header.right) / 2)).toBeLessThan(
    1,
  );

  await worktree.switchWorktreeFromFlyout(WS_BETA);
  await expect(layout.headerWorktreeName).toHaveText(BETA);
  await expect(worktree.cachedPanelEntries(WS_BETA)).toBeVisible();
  // The worktree just left stays mounted, hidden and inert.
  await expect(worktree.cachedPanelEntries(WS_ALPHA)).toHaveAttribute("inert");
  await expect(worktree.cachedPanelEntries(WS_ALPHA)).toBeHidden();

  await worktree.switchWorktreeFromFlyout(WS_ALPHA);
  await expect(layout.headerWorktreeName).toHaveText(ALPHA);
  await expect(chat.assistantMessage('Heard "remember me"')).toBeVisible();
  expect(await worktree.isMountedWorktreeMarked(WS_ALPHA)).toBe(true);
  await expect(worktree.cachedPanelEntries(WS_ALPHA)).not.toHaveAttribute("inert");
  await expect(worktree.cachedPanelEntries(WS_BETA)).toHaveAttribute("inert");
  expect(fullReplays()).toHaveLength(1);
});

test("a sheet opened in one worktree does not carry over to the next", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const layout = new MobileLayoutPage(page, server.url, TOKEN);
  const checks = new PrChecksPanelPage(page, server.url, TOKEN);

  await worktree.gotoAndWaitForPlugins(WS_ALPHA);
  await worktree.waitForMobileReady();
  await worktree.tapPrBadgeInFlyout(WS_BETA);
  await expect(checks.number).toHaveText("#802");
  await layout.closePluginSheet(CHECKS);

  // Back in the worktree the badge was tapped from: no sheet is open.
  await worktree.switchWorktreeFromFlyout(WS_ALPHA);
  await expect(layout.headerWorktreeName).toHaveText(ALPHA);
  await expect(layout.pluginSheetBody(CHECKS)).toBeHidden();

  // And the badge's request was used up: the Checks sheet doesn't come back.
  await worktree.switchWorktreeFromFlyout(WS_BETA);
  await expect(layout.headerWorktreeName).toHaveText(BETA);
  await expect(layout.pluginSheetBody(CHECKS)).toBeHidden();
});

test("the repo-list fly-out's Repos header is as tall as the header", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const layout = new MobileLayoutPage(page, server.url, TOKEN);

  await worktree.goto(WS_ALPHA);
  await worktree.waitForMobileReady();
  const header = await layout.readLayout(layout.header);

  await worktree.openRepoListFlyout();
  const topBar = await layout.readLayout(layout.flyoutTopBar);
  expect(topBar.top).toBe(header.top);
  expect(topBar.bottom).toBe(header.bottom);
});

test("the Checks tab opens from the header's panel menu", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const layout = new MobileLayoutPage(page, server.url, TOKEN);
  const checks = new PrChecksPanelPage(page, server.url, TOKEN);

  await worktree.gotoAndWaitForPlugins(WS_ALPHA);
  await worktree.waitForMobileReady();
  await layout.openPluginSheet(CHECKS);
  await expect(checks.number).toHaveText("#801");
});

test("tapping another worktree's PR badge opens that worktree on its Checks tab", async ({
  page,
}) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const layout = new MobileLayoutPage(page, server.url, TOKEN);
  const checks = new PrChecksPanelPage(page, server.url, TOKEN);

  await worktree.gotoAndWaitForPlugins(WS_ALPHA);
  await worktree.waitForMobileReady();
  await worktree.tapPrBadgeInFlyout(WS_BETA);

  await expect(page).toHaveURL(new RegExp(`/worktree/${WS_BETA}`));
  await expect(layout.pluginSheetBody(CHECKS)).toBeVisible();
  await expect(checks.number).toHaveText("#802");
  await expect(worktree.repoListFlyout).toBeHidden();
});
