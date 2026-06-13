/**
 * Mobile workspace switcher coverage (PR #553).
 *
 * Two behaviours, both mobile-only:
 *
 *  1. The workspace header title is a button ("Switch workspace") that opens
 *     the WorkspacePickerDialog, and the dialog can be dismissed (Escape) to
 *     stay on the current workspace — the user is never forced to make a
 *     selection to get out of it.
 *
 *  2. The active workspace stays marked active after navigating back to the
 *     project-list menu route (`/`). This guards the removal of the
 *     `setActiveWorkspace(null)` unmount-clear effect in
 *     `workspace.$workspaceId.tsx`: on mobile the menu lives on a separate
 *     route from the workspace, so clearing the store on unmount would leave
 *     the menu unable to highlight the workspace the user just came from.
 *
 * A real git repo backs the project so it reconciles to kind "git" and its
 * branch renders as a WorkspaceCard (whose `data-active` attribute is the
 * observable active marker) — fake paths reconcile to "plain" and render only
 * a flat header. Real production binary, no tRPC mocks, page objects only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";
import { WorkspacePicker } from "./pages/WorkspacePicker";

const TOKEN = "e2e-workspace-switcher-mobile-token";
const PROJECT = "switcher-mobile-repo";
const DEFAULT_BRANCH = "main";

const WORKSPACE = toWorkspaceId(PROJECT, DEFAULT_BRANCH);

// Narrow viewport — `useIsDesktop()` reports false (threshold 1024 px), so the
// mobile branch of `workspace.$workspaceId.tsx` mounts (header title button +
// back button) and the `/` route renders the full-screen DashboardShell menu.
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

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Switcher mobile test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "init"], tmpHome);

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Mobile workspace switcher", () => {
  test("the header title opens the picker, which can be dismissed without selecting", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();

    await workspacePage.openSwitcherFromHeader();
    await picker.waitVisible();

    await picker.dismiss();

    // Establish the positive anchor first: the mobile layout is interactive
    // again and we're still on the same workspace (dismissing did not
    // navigate). Only then assert the dialog is gone, so the negative
    // assertion has live state to anchor against.
    await workspacePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKSPACE));
    await expect(picker.dialog).toBeHidden();
  });

  test("the workspace stays active after returning to the project-list menu", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();

    await workspacePage.goBackToProjectList();

    // On the menu route, the workspace we came from is still marked active
    // (data-active) — the store retained `activeWorkspaceId` across the
    // route change. Asserting on the active-scoped locator proves both that
    // the card rendered and that it carries the active marker.
    await expect(workspacePage.activeWorkspaceCard(WORKSPACE)).toBeVisible();
  });
});
