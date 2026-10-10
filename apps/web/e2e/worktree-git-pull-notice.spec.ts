/**
 * A sidebar "Git pull" that git refuses because of uncommitted local changes
 * shows an informational notice in the bottom-right toast stack, naming the
 * changed file, instead of a raw tRPC error. A pull that genuinely fails shows
 * an error notice with git's message, which stays until closed. On a phone the
 * stack sits above the dashboard's action bar.
 *
 * Real production server, real git repo with a real bare origin one commit
 * ahead. No tRPC mocking, no `page.route()`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";
import { ToastHostPage } from "./pages/ToastHostPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-git-pull-notice-token";
const REPO = "pull-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
/** A repo whose origin no longer exists, so a pull really fails. */
const BROKEN_REPO = "broken-repo";
const BROKEN_WORKTREE = toWorktreeId(BROKEN_REPO, BRANCH, "local");
/** `ToastHost`'s `right-4` / `bottom-4` gutter, in CSS px. */
const GUTTER = 16;

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const originPath = join(tmpHome, "origin.git");
  const repoPath = join(tmpHome, REPO);
  const seederPath = join(tmpHome, "seeder");
  mkdirSync(originPath, { recursive: true });
  gitInHome(originPath, ["init", "--bare", "-b", BRANCH], tmpHome);

  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-b", BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Pull notice test\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-m", "initial commit"], tmpHome);
  gitInHome(repoPath, ["remote", "add", "origin", originPath], tmpHome);
  gitInHome(repoPath, ["push", "-u", "origin", BRANCH], tmpHome);

  // Origin moves one commit ahead, and the worktree has an uncommitted
  // edit, so `git pull --rebase` refuses.
  gitInHome(tmpHome, ["clone", originPath, seederPath], tmpHome);
  writeFileSync(join(seederPath, "upstream.md"), "# From upstream\n");
  gitInHome(seederPath, ["add", "."], tmpHome);
  gitInHome(seederPath, ["commit", "-m", "upstream change"], tmpHome);
  gitInHome(seederPath, ["push", "origin", BRANCH], tmpHome);
  rmSync(seederPath, { recursive: true, force: true });
  writeFileSync(join(repoPath, "README.md"), "# Edited locally\n");

  const brokenPath = join(tmpHome, BROKEN_REPO);
  mkdirSync(brokenPath, { recursive: true });
  gitInHome(brokenPath, ["init", "-b", BRANCH], tmpHome);
  writeFileSync(join(brokenPath, "README.md"), "# Broken origin\n");
  gitInHome(brokenPath, ["add", "."], tmpHome);
  gitInHome(brokenPath, ["commit", "-m", "initial commit"], tmpHome);
  gitInHome(brokenPath, ["remote", "add", "origin", join(tmpHome, "missing.git")], tmpHome);
  gitInHome(brokenPath, ["config", `branch.${BRANCH}.remote`, "origin"], tmpHome);
  gitInHome(brokenPath, ["config", `branch.${BRANCH}.merge`, `refs/heads/${BRANCH}`], tmpHome);

  const repo = (name: string, path: string) => ({
    name,
    path,
    defaultBranch: BRANCH,
    worktrees: [{ branch: BRANCH, path }],
  });
  seedState(tmpHome, {
    repos: [repo(REPO, repoPath), repo(BROKEN_REPO, brokenPath)],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Git pull with local changes", () => {
  test("shows an info notice in the bottom-right corner", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const toasts = new ToastHostPage(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();

    await worktreePage.pullWorktreeFromSidebar(WORKTREE);

    const notice = toasts.infoNotices.first();
    await expect(notice).toBeVisible();
    await expect(toasts.notices).toHaveCount(1);
    await expect(notice).toContainText(
      "Pull skipped: commit or stash your local changes first (README.md).",
    );

    // The card slides in from 8px lower, so wait for it to settle.
    await expect
      .poll(async () => {
        const { bottom, viewportHeight } = await toasts.readPlacement(notice);
        return Math.round(viewportHeight - bottom);
      })
      .toBe(GUTTER);
    const placement = await toasts.readPlacement(notice);
    expect(Math.round(placement.viewportWidth - placement.right)).toBe(GUTTER);
    expect(placement.left).toBeGreaterThan(placement.viewportWidth / 2);
    expect(placement.top).toBeGreaterThan(placement.viewportHeight / 2);
  });

  test("a pull that really fails shows an error that stays until closed", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const toasts = new ToastHostPage(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();

    await worktreePage.pullWorktreeFromSidebar(BROKEN_WORKTREE);
    const error = toasts.errorNotices.first();
    await expect(error).toContainText("does not appear to be a git repository");
    await expect(error).not.toContainText("TRPCClientError");

    // An info notice closes itself; once it has, the error is still there.
    await worktreePage.pullWorktreeFromSidebar(WORKTREE);
    await expect(toasts.infoNotices).toHaveCount(1);
    await expect(toasts.infoNotices).toHaveCount(0, { timeout: 15_000 });
    await expect(toasts.errorNotices).toHaveCount(1);

    await toasts.openErrorDetails();
    await expect(toasts.detailsDialog).toContainText("does not appear to be a git repository");
  });
});

test.describe("Git pull notice on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("sits above the dashboard action bar", async ({ page }) => {
    const layout = new MobileLayoutPage(page, server.url, TOKEN);
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const toasts = new ToastHostPage(page);
    await layout.gotoDashboard();
    await expect(layout.dashboardActionBar).toBeVisible();

    await worktreePage.pullWorktreeFromSidebar(WORKTREE);
    const notice = toasts.infoNotices.first();
    await expect(notice).toBeVisible();

    await expect
      .poll(async () => {
        const [toast, actionBar] = await Promise.all([
          layout.readLayout(notice),
          layout.readLayout(layout.dashboardActionBar),
        ]);
        return toast.bottom - actionBar.top;
      })
      .toBeLessThanOrEqual(0);
  });
});
