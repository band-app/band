/**
 * The desktop window's drag region must never cover a control in the top row.
 *
 * On desktop the center tab strip is the window's top row, and the empty part
 * of each top-row group's strip (`.dv-void-container`) is `app-region: drag`.
 * Chromium builds the window's drag region from every element in document
 * order whose `visibility` is `visible`, whether or not it shows (z-index,
 * `inert` and `pointer-events` don't count), so any drag rect that lands on a
 * tab makes clicking the tab start a window drag in the desktop app, and
 * dockview never sees the click or the tab's HTML5 drag. That happened with
 * several workspaces open: hidden workspaces stay mounted at the same place
 * as the visible one, and their strips' empty space covered the visible
 * workspace's tabs.
 *
 * Electron is the only place that hit-tests the drag region, and the e2e
 * harness boots the web build in plain Chromium, so these tests assert the
 * DOM-level projection: `controlsUnderWindowDragRegion()` replays Chromium's
 * union-and-subtract walk over the computed `app-region` values and returns
 * every tab, tab close button, header button or nav button it covers.
 *
 * A hidden entry's panes must also compute `visibility: hidden`. Dockview's
 * `dv-view visible` state class used to match Tailwind's `.visible` utility,
 * so they computed `visible`. In the desktop app with the CDP screencast
 * setting on, a hidden workspace holding a browser pane keeps painting, and
 * its whole tab strip then covered the shown workspace's. The e2e build has
 * no `<webview>`, so the test checks the computed visibility.
 *
 * Architecture: the real production server against a fresh tmp `~/.band/`,
 * one seeded repo with two worktrees, no tRPC mocking, driven through `WorkspacePage`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-tab-strip-drag-region-token";
const PROJECT = "drag-region-repo";
const WORKSPACE_A = toWorkspaceId(PROJECT, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT, "second");

// Wide viewport so the desktop layout (sidebar + dockview) renders
// (>= 1024px in useIsDesktop.ts).
test.use({ viewport: { width: 1400, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // A real repo with a second worktree: two workspace cards in the sidebar,
  // and real directories for each default terminal's shell.
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# drag region\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  const secondPath = join(tmpHome, `${PROJECT}-second`);
  gitInHome(repoPath, ["worktree", "add", "-q", "-b", "second", secondPath], tmpHome);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: repoPath },
          { branch: "second", path: secondPath },
        ],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

// UI state lives on the server: start each test from none.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a hidden workspace's tab strip doesn't cover the visible workspace's tabs", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  // A keeps its single default tab, so its strip's empty space starts right
  // after one tab: exactly where B's second and third tabs sit.
  await wp.goto(WORKSPACE_A);
  await wp.waitForReady();
  await wp.switchWorkspace(WORKSPACE_B);
  await wp.waitForWorkspaceReady(WORKSPACE_B);
  await wp.clickTerminalAddTab(WORKSPACE_B);
  await wp.clickTerminalAddTab(WORKSPACE_B);
  await expect(wp.terminalTabs()).toHaveCount(3);
  // A is still mounted, hidden behind B.
  await expect(wp.cachedPanelEntries(WORKSPACE_A)).toHaveCount(1);
  // A's tab inherits its `visibility: hidden`, B's tabs are visible.
  expect(await wp.centerTabVisibilitiesIn(WORKSPACE_A)).toEqual(["hidden"]);
  expect(await wp.centerTabVisibilitiesIn(WORKSPACE_B)).toEqual(["visible", "visible", "visible"]);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);

  // With both side panels collapsed the strip also carries the sidebar gutter
  // (a drag rect) and the right sidepanel's expand button.
  await wp.revealRightPanel();
  await wp.collapseRightPanelViaHeader();
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarGutter).toHaveCount(1);
  await expect(wp.rightPanelTogglesInTabStrips).toHaveCount(1);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
});

test("split and maximized top-row groups keep their tabs and buttons out of the drag region", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE_A);
  await wp.waitForReady();
  await wp.switchWorkspace(WORKSPACE_B);
  await wp.waitForWorkspaceReady(WORKSPACE_B);
  await wp.openChat(WORKSPACE_B);
  await wp.clickChatSplitRight(WORKSPACE_B);
  await expect(wp.centerToolbars).toHaveCount(2);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);

  await wp.maximizePanel(0);
  await expect(wp.restoreButton).toBeVisible();

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
});
