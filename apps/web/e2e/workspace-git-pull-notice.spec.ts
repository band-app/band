/**
 * A sidebar "Git pull" that git refuses because of uncommitted local changes
 * shows an informational notice in the bottom-right toast stack, naming the
 * changed file, instead of a raw tRPC error.
 *
 * Real production server, real git repo with a real bare origin one commit
 * ahead. No tRPC mocking, no `page.route()`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ToastHostPage } from "./pages/ToastHostPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-workspace-git-pull-notice-token";
const PROJECT = "pull-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);
/** `ToastHost`'s `right-4` / `bottom-4` gutter, in CSS px. */
const GUTTER = 16;

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const originPath = join(tmpHome, "origin.git");
  const repoPath = join(tmpHome, PROJECT);
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

  // Origin moves one commit ahead, and the workspace has an uncommitted
  // edit, so `git pull --rebase` refuses.
  gitInHome(tmpHome, ["clone", originPath, seederPath], tmpHome);
  writeFileSync(join(seederPath, "upstream.md"), "# From upstream\n");
  gitInHome(seederPath, ["add", "."], tmpHome);
  gitInHome(seederPath, ["commit", "-m", "upstream change"], tmpHome);
  gitInHome(seederPath, ["push", "origin", BRANCH], tmpHome);
  rmSync(seederPath, { recursive: true, force: true });
  writeFileSync(join(repoPath, "README.md"), "# Edited locally\n");

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
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
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const toasts = new ToastHostPage(page);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    await workspacePage.pullWorkspaceFromSidebar(WORKSPACE);

    const notice = toasts.notices.first();
    await expect(notice).toBeVisible();
    await expect(toasts.notices).toHaveCount(1);
    await expect(notice).toHaveAttribute("data-tone", "info");
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
});
