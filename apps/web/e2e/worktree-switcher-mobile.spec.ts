/**
 * Mobile worktree switcher coverage (PR #553).
 *
 * Two behaviours, both mobile-only:
 *
 *  1. The worktree header title is a button ("Switch worktree") that opens
 *     the WorktreePickerDialog, and the dialog can be dismissed (Escape) to
 *     stay on the current worktree — the user is never forced to make a
 *     selection to get out of it.
 *
 *  2. The active worktree stays marked active inside the repo-list
 *     fly-out. The hamburger opens the repo list as a drawer *over* the
 *     still-mounted worktree (no route change / no unmount), so the store
 *     retains `activeWorktreeId` and the card inside the drawer keeps its
 *     `data-active` marker — the affordance the user relies on to see which
 *     worktree they're currently in.
 *
 * A real git repo backs the repo so it reconciles to kind "git" and its
 * branch renders as a WorktreeCard (whose `data-active` attribute is the
 * observable active marker) — fake paths reconcile to "plain" and render only
 * a flat header. Real production binary, no tRPC mocks, page objects only.
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
import { WorktreePicker } from "./pages/WorktreePicker";

const TOKEN = "e2e-worktree-switcher-mobile-token";
const REPO = "switcher-mobile-repo";
const DEFAULT_BRANCH = "main";

const WORKTREE = toWorktreeId(REPO, DEFAULT_BRANCH);

// Narrow viewport — `useIsDesktop()` reports false (threshold 1024 px), so the
// mobile branch of `worktree.$worktreeId.tsx` mounts: a header with the
// title "Switch worktree" button and the hamburger that opens the
// repo-list fly-out.
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
  writeFileSync(join(repoPath, "README.md"), "# Switcher mobile test\n");
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

test.describe("Mobile worktree switcher", () => {
  test("the header title opens the picker, which can be dismissed without selecting", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();

    await worktreePage.openSwitcherFromHeader();
    await picker.waitVisible();

    await picker.dismiss();

    // Establish the positive anchor first: the mobile layout is interactive
    // again and we're still on the same worktree (dismissing did not
    // navigate). Only then assert the dialog is gone, so the negative
    // assertion has live state to anchor against.
    await worktreePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKTREE));
    await expect(picker.dialog).toBeHidden();
  });

  test("the current worktree is marked active in the repo-list fly-out", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();

    // Open the repo-list fly-out over the worktree (no route change).
    await worktreePage.openRepoListFlyout();

    // Inside the fly-out the worktree we're viewing is still marked active
    // (data-active) — the store retained `activeWorktreeId`. The locator is
    // scoped to the drawer, so it proves both that the card rendered *inside
    // the fly-out* and that it carries the active marker.
    await expect(worktreePage.activeWorktreeCardInFlyout(WORKTREE)).toBeVisible();
  });
});
