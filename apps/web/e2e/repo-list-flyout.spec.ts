/**
 * Mobile repo-list fly-out coverage.
 *
 * On a narrow viewport the worktree header's hamburger opens the full repo
 * list as a left-edge drawer *over* the current worktree. The defining
 * contract is that opening or closing the drawer is a pure overlay — it never
 * changes the route/URL, so the worktree stays mounted underneath.
 *
 * A real git repo backs the repo so its branch reconciles to a
 * WorktreeCard (whose `data-active` attribute is the observable active
 * marker) and the DashboardShell inside the drawer renders its
 * `repo-list__root`. Real production binary, no tRPC mocks, page objects
 * only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-repo-list-flyout-token";
const REPO = "flyout-repo";
const DEFAULT_BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, DEFAULT_BRANCH);

// Narrow viewport so `useIsDesktop()` reports false (threshold 1024px) and the
// mobile branch of `worktree.$worktreeId.tsx` mounts (header hamburger).
test.use({ viewport: { width: 800, height: 900 } });

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(cwd: string, args: string[], home: string): void {
  execFileSync("git", args, { cwd, env: makeGitEnv(home) });
}

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Flyout test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "init"], tmpHome);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Mobile repo-list fly-out", () => {
  test("the hamburger opens the repo list as an overlay without changing the route", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKTREE));

    await worktreePage.openRepoListFlyout();

    // The full repo list rendered inside the drawer…
    await expect(worktreePage.repoListRoot()).toBeVisible();
    // …and opening it did NOT navigate — still on the same worktree route.
    await expect(page).toHaveURL(new RegExp(WORKTREE));
  });

  test("dismissing via the backdrop closes the drawer and keeps the route", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();

    await worktreePage.openRepoListFlyout();
    await worktreePage.dismissRepoListFlyoutViaBackdrop();

    // Positive anchor first: the worktree is interactive again and we're
    // still on the same route (dismissing did not navigate). Only then assert
    // the drawer is gone.
    await worktreePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKTREE));
    await expect(worktreePage.repoListFlyout).toBeHidden();
  });

  test("dismissing via Escape closes the drawer and keeps the route", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();

    await worktreePage.openRepoListFlyout();
    await worktreePage.pressEscape();

    await worktreePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKTREE));
    await expect(worktreePage.repoListFlyout).toBeHidden();
  });
});
