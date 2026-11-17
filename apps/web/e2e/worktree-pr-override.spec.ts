/**
 * Setting a worktree's pull request by hand in the sidebar: "Set pull request…" in the row's
 * menu takes a PR URL and the badge shows it with a manual marker; Edit then Clear in the badge's
 * popover returns the row to the detected PR (none here).
 *
 * Real server, a real repo with a github.com `origin`, and the fake `gh` selected through
 * `BAND_GH_BIN` (`apps/hub/tests/fixtures/gh-stub.ts`). No tRPC mocking. Locators live in
 * `pages/PullRequestBadgePage.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  branchRepository,
  prNode,
  prUrl,
  workflowSuite,
} from "../../hub/tests/fixtures/branch-status-data";
import { type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
import { FAKE_REPO } from "../../hub/tests/fixtures/github-review-data";
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
import { PullRequestBadgePage } from "./pages/PullRequestBadgePage";

test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-pr-override-token";
const REPO = "widgets";
const BRANCH = "feat/no-detected-pr";
const wsId = (branch: string) => toWorktreeId(REPO, branch, "local");

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
  const path = join(tmpHome, "wt-no-detected-pr");
  git(repo, ["worktree", "add", "-b", BRANCH, path]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [
          { name: "main", branch: "main", path: repo },
          { name: BRANCH, branch: BRANCH, path },
        ],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  stub = await ghStub.start();
  stub.setBranchStatusQuery(FAKE_REPO, () =>
    branchRepository({ suites: [workflowSuite({ workflow: "CI" })] }),
  );
  stub.setPullRequestQuery(FAKE_REPO, (number) =>
    number === 93
      ? {
          ...prNode({ number: 93, title: "chosen by hand" }),
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
        }
      : undefined,
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

test("S4: Edit sets the PR with a manual marker, Clear returns to automatic", async ({ page }) => {
  const badges = new PullRequestBadgePage(page, server.url, TOKEN);
  await badges.goto(wsId("main"));

  // Detection finds no PR for the branch: its CI icon shows.
  await expect(badges.ciIcon(wsId(BRANCH))).toBeVisible();
  await expect(badges.badge(wsId(BRANCH))).toHaveCount(0);

  await badges.setPullRequest(wsId(BRANCH), prUrl(93));
  await expect(badges.badge(wsId(BRANCH))).toContainText("#93");
  await expect(badges.badge(wsId(BRANCH))).toHaveAttribute("data-tone", "failure");
  await expect(badges.manualMarker(wsId(BRANCH))).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pr-set-by-hand.png") });

  await badges.clearPullRequest(wsId(BRANCH));
  await expect(badges.badge(wsId(BRANCH))).toHaveCount(0);
  await expect(badges.ciIcon(wsId(BRANCH))).toBeVisible();
});
