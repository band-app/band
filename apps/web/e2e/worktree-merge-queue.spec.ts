/**
 * A PR in GitHub's merge queue: the sidebar badge turns "queued" with the queue position in its
 * popover, and the Checks tab says where the PR is in the queue or that auto-merge is waiting.
 * Covers the one-line repo list, the two-line Groups view with a pinned worktree, and a phone
 * width, plus a PR that is merely open and one whose stored row predates the queue fields.
 *
 * Real server, a real repo with a github.com `origin`. `gh` is the fake in
 * `tests/fixtures/gh-stub-bin.mjs` (BAND_GH_BIN), answered by the Express stub in
 * `tests/fixtures/gh-stub.ts`. No tRPC mocking. Locators live in `pages/`.
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
import { trpcMutate } from "./helpers/trpc";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";
import { PrChecksPanelPage } from "./pages/PrChecksPanelPage";
import { PullRequestBadgePage } from "./pages/PullRequestBadgePage";
import { WorktreePage } from "./pages/WorktreePage";

const REPO = "widgets";
const QUEUED = "feat/queued";
const AUTO = "feat/auto-merge";
const PLAIN = "feat/plain";
const wsId = (branch: string) => toWorktreeId(REPO, branch, "local");

const PRS = {
  [QUEUED]: {
    number: 801,
    mergeQueue: { state: "AWAITING_CHECKS" as const, position: 2, total: 3 },
  },
  [AUTO]: { number: 802, autoMerge: true },
  [PLAIN]: { number: 803 },
};

interface Fixture {
  server: ServerHandle;
  stub: GhStub;
  tmpHome: string;
}

async function setup(token: string, withGroups: boolean): Promise<Fixture> {
  const tmpHome = createTmpHome();
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
  const branches = [QUEUED, AUTO, PLAIN];
  const worktrees = branches.map((branch) => {
    const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
    git(repo, ["worktree", "add", "-b", branch, path]);
    return { name: branch, branch, path, ...(withGroups && { groupId: "g-team" }) };
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
    ...(withGroups && { groups: [{ id: "g-team", name: "Team", color: "#3b82f6" }] }),
  });
  seedSettings(tmpHome, { tokenSecret: token });

  const stub = await ghStub.start();
  stub.setBranchStatusQuery(FAKE_REPO, (branch) => {
    const pr = PRS[branch as keyof typeof PRS];
    return pr
      ? branchRepository({
          pullRequests: [prNode({ title: `PR for ${branch}`, ...pr })],
          suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
        })
      : undefined;
  });
  for (const branch of branches) {
    stub.setReviewQuery(
      FAKE_REPO,
      branch,
      reviewQueryData({
        pullRequests: [
          pullRequestNode({
            title: `PR for ${branch}`,
            ...PRS[branch as keyof typeof PRS],
            contexts: [checkRunNode({ id: 1, name: "Lint" })],
          }),
        ],
      }),
    );
  }
  const server = await startServer({ tmpHome, env: stub.env });
  return { server, stub, tmpHome };
}

async function teardown(f: Fixture | undefined): Promise<void> {
  await f?.server.close();
  await f?.stub.stop();
  if (f) cleanupTmpHome(f.tmpHome);
}

function describeLayout(
  title: string,
  token: string,
  opts: { groups: boolean; pinned?: boolean; mobile?: boolean },
) {
  test.describe(title, () => {
    if (opts.mobile) {
      test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    } else {
      test.use({ viewport: { width: 1920, height: 900 } });
    }
    let f: Fixture;

    test.beforeAll(async () => {
      f = await setup(token, opts.groups);
      if (opts.pinned) {
        await trpcMutate(f.server.url, token, "worktrees.setPinned", {
          repo: REPO,
          name: QUEUED,
          pinned: true,
        });
      }
    });
    test.afterAll(() => teardown(f));
    test.beforeEach(() => resetClientState(f.tmpHome));

    test("the badge of a queued PR is its own tone, and the popover gives the position", async ({
      page,
    }) => {
      const badges = new PullRequestBadgePage(page, f.server.url, token);
      if (opts.mobile) {
        // On a phone the badges are in the repo list's fly-out over a worktree.
        const worktree = new WorktreePage(page, f.server.url, token);
        await worktree.gotoAndWaitForPlugins(wsId("main"));
        await worktree.waitForMobileReady();
        await worktree.openRepoListFlyout();
      } else {
        await badges.goto(wsId("main"));
      }

      await expect(badges.badge(wsId(QUEUED))).toHaveText("#801");
      await expect(badges.badge(wsId(QUEUED))).toHaveAttribute("data-tone", "queued");
      // Open and passing stays green; the queued tone is a different color.
      await expect(badges.badge(wsId(PLAIN))).toHaveAttribute("data-tone", "success");
      await expect(badges.badge(wsId(AUTO))).toHaveAttribute("data-tone", "success");
      const queuedColor = await badges.badgeColor(wsId(QUEUED));
      expect(queuedColor).not.toBe(await badges.badgeColor(wsId(PLAIN)));

      await badges.hoverBadge(wsId(QUEUED));
      await expect(badges.popoverStatus).toContainText("In merge queue · position 2");
      await expect(badges.popoverQueue).toContainText("Awaiting checks");
      await badges.moveMouseAway();

      await badges.hoverBadge(wsId(AUTO));
      await expect(badges.popoverAutoMerge).toHaveText("Auto-merge on");
      await expect(badges.popoverQueue).toHaveCount(0);
      await badges.moveMouseAway();

      await badges.hoverBadge(wsId(PLAIN));
      await expect(badges.popoverAutoMerge).toHaveCount(0);
      await expect(badges.popoverQueue).toHaveCount(0);
    });

    test("the Checks tab says where the PR is in the queue", async ({ page }) => {
      const checks = new PrChecksPanelPage(page, f.server.url, token);
      const open = async (branch: string) => {
        if (!opts.mobile) return checks.goto(wsId(branch));
        const worktree = new WorktreePage(page, f.server.url, token);
        const layout = new MobileLayoutPage(page, f.server.url, token);
        await worktree.gotoAndWaitForPlugins(wsId(branch));
        await worktree.waitForMobileReady();
        await layout.openPluginSheet("github-pull-request");
      };
      await open(QUEUED);
      await expect(checks.mergeQueueLine).toContainText("In merge queue, position 2 of 3");
      await expect(checks.mergeQueueLine).toContainText("awaiting checks");
      await expect(checks.autoMergeLine).toHaveCount(0);

      await open(AUTO);
      await expect(checks.autoMergeLine).toHaveText("Auto-merge on, waiting for checks");
      await expect(checks.mergeQueueLine).toHaveCount(0);

      await open(PLAIN);
      await expect(checks.number).toHaveText("#803");
      await expect(checks.mergeQueueLine).toHaveCount(0);
      await expect(checks.autoMergeLine).toHaveCount(0);
    });
  });
}

describeLayout("one-line repo list", "e2e-merge-queue-flat", { groups: false });
describeLayout("Groups view with a pinned worktree", "e2e-merge-queue-groups", {
  groups: true,
  pinned: true,
});
describeLayout("phone width", "e2e-merge-queue-mobile", { groups: false, mobile: true });
