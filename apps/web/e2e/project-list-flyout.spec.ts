/**
 * Mobile project-list fly-out coverage.
 *
 * On a narrow viewport the workspace header's hamburger opens the full project
 * list as a left-edge drawer *over* the current workspace. The defining
 * contract is that opening or closing the drawer is a pure overlay — it never
 * changes the route/URL, so the workspace stays mounted underneath.
 *
 * A real git repo backs the project so its branch reconciles to a
 * WorkspaceCard (whose `data-active` attribute is the observable active
 * marker) and the DashboardShell inside the drawer renders its
 * `project-list__root`. Real production binary, no tRPC mocks, page objects
 * only.
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

const TOKEN = "e2e-project-list-flyout-token";
const PROJECT = "flyout-repo";
const DEFAULT_BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, DEFAULT_BRANCH);

// Narrow viewport so `useIsDesktop()` reports false (threshold 1024px) and the
// mobile branch of `workspace.$workspaceId.tsx` mounts (header hamburger).
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
  writeFileSync(join(repoPath, "README.md"), "# Flyout test\n");
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

test.describe("Mobile project-list fly-out", () => {
  test("the hamburger opens the project list as an overlay without changing the route", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKSPACE));

    await workspacePage.openProjectListFlyout();

    // The full project list rendered inside the drawer…
    await expect(workspacePage.projectListRoot()).toBeVisible();
    // …and opening it did NOT navigate — still on the same workspace route.
    await expect(page).toHaveURL(new RegExp(WORKSPACE));
  });

  test("dismissing via the backdrop closes the drawer and keeps the route", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();

    await workspacePage.openProjectListFlyout();
    await workspacePage.dismissProjectListFlyoutViaBackdrop();

    // Positive anchor first: the workspace is interactive again and we're
    // still on the same route (dismissing did not navigate). Only then assert
    // the drawer is gone.
    await workspacePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKSPACE));
    await expect(workspacePage.projectListFlyout).toBeHidden();
  });

  test("dismissing via Escape closes the drawer and keeps the route", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();

    await workspacePage.openProjectListFlyout();
    await workspacePage.pressEscape();

    await workspacePage.waitForMobileReady();
    await expect(page).toHaveURL(new RegExp(WORKSPACE));
    await expect(workspacePage.projectListFlyout).toBeHidden();
  });
});
