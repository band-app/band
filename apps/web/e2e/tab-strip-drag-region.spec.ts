/**
 * The desktop window's drag region must never cover a control in the top row.
 *
 * On desktop the center tab strip is the window's top row, and the empty part
 * of each top-row group's strip (`.dv-void-container`) is `app-region: drag`.
 * Chromium builds the window's drag region from every element in document
 * order, visible or not, so any drag rect that lands on a tab makes clicking
 * the tab start a window drag in the desktop app, and dockview never sees the
 * click or the tab's HTML5 drag. That happened with several workspaces open:
 * hidden workspaces stay mounted at the same place as the visible one, and
 * their strips' empty space covered the visible workspace's tabs.
 *
 * Electron is the only place that hit-tests the drag region, and the e2e
 * harness boots the web build in plain Chromium, so these tests assert the
 * DOM-level projection: `controlsUnderWindowDragRegion()` replays Chromium's
 * union-and-subtract walk over the computed `app-region` values and returns
 * every tab, tab close button, header button or nav button it covers.
 *
 * Not covered here: a hidden workspace locked with `content-visibility:
 * hidden` before its descendants took the `[inert]` app-region reset kept
 * their stale `drag` in Chromium's region. `getComputedStyle` forces the
 * skipped recalc, so any DOM-level read sees the reset and the walk passes
 * either way. That cause was reproduced and its fix verified with real
 * native clicks in Electron 42 (see the PR); these tests only check that
 * hidden workspaces stay parked and the visible layout stays clear.
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
import { CenterTabStrip } from "./pages/CenterTabStrip";
import { CommandPalette } from "./pages/CommandPalette";
import { WindowDragRegionOverlay } from "./pages/WindowDragRegionOverlay";
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

  await wp.restorePanel();
  await expect(wp.maximizeButtons).toHaveCount(2);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
});

test("an overflowing, scrolled tab strip keeps every visible tab out of the drag region", async ({
  page,
}) => {
  // Nine tabs opened through the "+" menu take longer than the default 30 s.
  test.setTimeout(90_000);
  const wp = new WorkspacePage(page, server.url, TOKEN);
  const strip = new CenterTabStrip(page);
  await wp.goto(WORKSPACE_A);
  await wp.waitForReady();
  // Ten ~100px tabs overflow the ~830px center column between the side
  // panels: the empty strip space (`.dv-void-container`) shrinks to nothing
  // and the tab list scrolls.
  for (let i = 0; i < 9; i++) await wp.clickTerminalAddTab(WORKSPACE_A);
  await expect(wp.terminalTabs()).toHaveCount(10);
  await expect.poll(async () => (await strip.readScroll()).maxScrollLeft).toBeGreaterThan(0);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);

  await strip.trackpadSwipe(400);
  await expect.poll(async () => (await strip.readScroll()).scrollLeft).toBeGreaterThan(0);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);

  // Collapsed sidebar: the tabs now scroll past the sidebar gutter's drag rect.
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarGutter).toHaveCount(1);
  await strip.trackpadSwipe(400);

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);

  // And back: the right sidepanel's expand button returns to the strip.
  await wp.revealRightPanel();
  await wp.collapseRightPanelViaHeader();
  await wp.expandRightPanelViaTabStrip();

  expect(await wp.controlsUnderWindowDragRegion()).toEqual([]);
});

test("the palette toggles an overlay of the window drag region", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  const palette = new CommandPalette(page);
  const overlay = new WindowDragRegionOverlay(page);
  await wp.goto(WORKSPACE_A);
  await wp.waitForReady();
  // B is mounted and hidden behind A: the overlay doesn't read parked entries.
  await wp.switchWorkspace(WORKSPACE_B);
  await wp.waitForWorkspaceReady(WORKSPACE_B);
  await wp.switchWorkspace(WORKSPACE_A);
  await wp.waitForWorkspaceReady(WORKSPACE_A);
  await expect(wp.cachedPanelEntries(WORKSPACE_B)).toHaveCount(1);
  await expect(overlay.root).toHaveCount(0);

  await palette.open();
  await palette.run("toggle-drag-region-overlay");

  await expect(overlay.root).toBeVisible();
  // The sidebar title bar, the strip's empty space and the sidepanel header.
  await expect.poll(() => overlay.dragRects.count()).toBeGreaterThanOrEqual(2);
  await expect(overlay.noDragRects.first()).toBeAttached();
  await expect(overlay.coveredControls).toHaveCount(0);

  await palette.open();
  await palette.run("toggle-drag-region-overlay");

  await expect(overlay.root).toHaveCount(0);
});
