/**
 * The desktop window's drag region must never cover a control in the top row.
 *
 * On desktop the center tab strip is the window's top row, but only the
 * sidebars drag the window: the left sidebar's title bar (and its gutter in the
 * strip while it is collapsed) and the right sidepanel's header. Nothing in the
 * center column is `app-region: drag`.
 * Chromium builds the window's drag region from every element in document
 * order whose `visibility` is `visible`, whether or not it shows (z-index,
 * `inert` and `pointer-events` don't count), so any drag rect that lands on a
 * tab makes clicking the tab start a window drag in the desktop app, and
 * the layout never sees the click or the tab's drag. That happened with
 * several worktrees open: hidden worktrees stay mounted at the same place
 * as the visible one, and their strips' empty space covered the visible
 * worktree's tabs. With no drag box in the center, that can't recur.
 *
 * Electron is the only place that hit-tests the drag region, and the e2e
 * harness boots the web build in plain Chromium, so these tests assert the
 * DOM-level projection: `controlsUnderWindowDragRegion()` replays Chromium's
 * union-and-subtract walk over the computed `app-region` values and returns
 * every tab, tab close button, header button or nav button it covers.
 *
 * A hidden entry's groups must also compute `visibility: hidden`. In the
 * desktop app with the CDP screencast setting on, a hidden worktree holding a
 * browser pane keeps painting, and a group that computed `visible` there put
 * its whole tab strip over the shown worktree's. The e2e build has no
 * `<webview>`, so the test checks the computed visibility.
 *
 * Architecture: the real production server against a fresh tmp `~/.band/`,
 * one seeded repo with two worktrees, no tRPC mocking, driven through `WorktreePage`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-tab-strip-drag-region-token";
const REPO = "drag-region-repo";
const WORKTREE_A = toWorktreeId(REPO, "main", "local");
const WORKTREE_B = toWorktreeId(REPO, "second", "local");

// Wide viewport so the desktop layout (sidebar + layout) renders
// (>= 1024px in useIsDesktop.ts).
test.use({ viewport: { width: 1400, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // A real repo with a second worktree: two worktree cards in the sidebar,
  // and real directories for each default terminal's shell.
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# drag region\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  const secondPath = join(tmpHome, `${REPO}-second`);
  gitInHome(repoPath, ["worktree", "add", "-q", "-b", "second", secondPath], tmpHome);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
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

test("a hidden worktree's tab strip doesn't cover the visible worktree's tabs", async ({
  page,
}) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  // A keeps its single default tab, so its strip's empty space starts right
  // after one tab: exactly where B's second and third tabs sit.
  await wp.goto(WORKTREE_A);
  await wp.waitForReady();
  await wp.switchWorktree(WORKTREE_B);
  await wp.waitForWorktreeReady(WORKTREE_B);
  await wp.clickTerminalAddTab(WORKTREE_B);
  await wp.clickTerminalAddTab(WORKTREE_B);
  await expect(wp.terminalTabs()).toHaveCount(3);
  // A is still mounted, hidden behind B.
  await expect(wp.cachedPanelEntries(WORKTREE_A)).toHaveCount(1);
  // A's tab inherits its `visibility: hidden`, B's tabs are visible.
  expect(await wp.centerTabVisibilitiesIn(WORKTREE_A)).toEqual(["hidden"]);
  expect(await wp.centerTabVisibilitiesIn(WORKTREE_B)).toEqual(["visible", "visible", "visible"]);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
  expect(await wp.appRegionsInHiddenWorktrees()).toEqual([]);

  // With both side panels collapsed the strip also carries the sidebar gutter
  // (a drag rect) and the right sidepanel's expand button.
  await wp.revealRightPanel();
  await wp.collapseRightPanelViaHeader();
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarGutter).toHaveCount(1);
  await expect(wp.rightPanelTogglesInTabStrips).toHaveCount(1);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
  // A's strip now carries a sidebar gutter too, and it must set no region.
  await expect(wp.sidebarGutterIn(WORKTREE_A)).toHaveCount(1);
  expect(await wp.appRegionsInHiddenWorktrees()).toEqual([]);
});

test("no drag box covers the center column, while the sidebar title bar and right header drag", async ({
  page,
}) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  await wp.goto(WORKTREE_A);
  await wp.waitForReady();
  await wp.clickTerminalAddTab(WORKTREE_A);
  await expect(wp.terminalTabs()).toHaveCount(2);

  expect(await wp.dragBoxesOverCenterColumn()).toBe(0);
  await wp.revealRightPanel();
  await expect(wp.rightPanelHeader).toBeVisible();
  expect(await wp.emptyTopRowSpotsInDragRegion()).toEqual({
    sidebarTitleBar: true,
    rightPanelHeader: true,
    strips: [false],
  });
  // Back to the single default tab, which later tests start from.
  await wp.closeTerminalTab(WORKTREE_A);
  await expect(wp.terminalTabs()).toHaveCount(1);
});

test("the empty center and the no-worktree center don't drag, and the expand button stays reachable", async ({
  page,
}) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  await wp.goto(WORKTREE_A);
  await wp.waitForReady();
  await wp.revealRightPanel();
  await wp.collapseRightPanelViaHeader();
  await wp.closeTerminalTab(WORKTREE_A);
  await expect(wp.centerDragBar).toBeVisible();

  expect(await wp.dragBoxesOverCenterColumn()).toBe(0);
  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
  await expect(wp.rightPanelToggleInDragBar).toBeVisible();
  await wp.rightPanelToggleInDragBar.click();
  await expect(wp.rightPanelHeader).toBeVisible();
});

test("a hidden worktree with every tab closed sets no app-region", async ({ page }) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  // Closing A's only tab replaces its strip with the center drag bar.
  await wp.goto(WORKTREE_A);
  await wp.waitForReady();
  await wp.closeTerminalTab(WORKTREE_A);
  await expect(wp.centerDragBar).toBeVisible();
  await wp.switchWorktree(WORKTREE_B);
  await wp.waitForWorktreeReady(WORKTREE_B);
  // A still renders its drag bar, now hidden.
  await expect(wp.centerDragBarIn(WORKTREE_A)).toHaveCount(1);

  expect(await wp.appRegionsInHiddenWorktrees()).toEqual([]);
  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
});

test("split and maximized top-row groups drag nothing and keep their tabs and buttons clickable", async ({
  page,
}) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  await wp.goto(WORKTREE_A);
  await wp.waitForReady();
  await wp.switchWorktree(WORKTREE_B);
  await wp.waitForWorktreeReady(WORKTREE_B);
  await wp.openChat(WORKTREE_B);
  await wp.clickChatSplitRight(WORKTREE_B);
  await expect(wp.centerToolbars).toHaveCount(2);

  expect(await wp.dragBoxesOverCenterColumn()).toBe(0);
  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);

  await wp.maximizePanel(0);
  await wp.expectMaximized(WORKTREE_B);

  expect(await wp.dragBoxesOverCenterColumn()).toBe(0);
  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
  expect(await wp.appRegionsInHiddenWorktrees()).toEqual([]);
});

// The app zoom is CSS `zoom` on <html>. A report from the desktop app (v0.44.0,
// 110%) had clicks on center-strip tabs start a window drag while no drag box
// covered them in the DOM. The center column now has no drag box at all; this
// checks the DOM-level region at the zoom levels people use, with the sidebar open and collapsed. 125% comes from a persisted
// setting on a reload, 100% and 110% from the real shortcuts, and 110% again
// from the app's own persistence after a reload.
test("tabs and strip buttons stay out of the drag region at 100%, 110% and 125% zoom", async ({
  page,
}) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  await wp.goto(WORKTREE_A);
  await wp.waitForReady();
  await wp.clickTerminalAddTab(WORKTREE_A);
  await wp.clickTerminalAddTab(WORKTREE_A);
  await expect(wp.terminalTabs()).toHaveCount(3);

  const expectTopRowAtZoom = async (zoom: number) => {
    await test.step(`Top row at ${Math.round(zoom * 100)}% zoom`, async () => {
      await expect.poll(() => wp.readAppZoom()).toBeCloseTo(zoom, 5);
      // Sidebar open: its title bar drags, the strip's empty space doesn't.
      await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(100);
      expect(await wp.dragBoxesOverCenterColumn()).toBe(0);
      expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
      expect(await wp.emptyTopRowSpotsInDragRegion()).toMatchObject({
        sidebarTitleBar: true,
        strips: [false],
      });
      // Sidebar collapsed: the strip carries the sidebar gutter.
      await wp.toggleSidebarViaButton();
      await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
      await expect(wp.sidebarGutter).toHaveCount(1);
      expect(await wp.dragBoxesOverCenterColumn()).toBe(0);
      expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
      expect(await wp.emptyTopRowSpotsInDragRegion()).toMatchObject({
        sidebarTitleBar: null,
        strips: [false],
      });
      await wp.toggleSidebarViaButton();
      await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(100);
    });
  };

  await wp.persistAppZoom(1.25);
  await wp.reload();
  await wp.waitForReady();
  await expectTopRowAtZoom(1.25);

  await wp.zoomResetViaShortcut();
  await expectTopRowAtZoom(1);

  await wp.zoomInBy(1);
  await expectTopRowAtZoom(1.1);

  await wp.reload();
  await wp.waitForReady();
  await expectTopRowAtZoom(1.1);
});
