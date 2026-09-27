/**
 * End-to-end coverage for the desktop layout's top row now that there is no
 * title bar over the center column.
 *
 * The center dockview's tab strip is the window's top row, level with the
 * sidebar's title bar and the right sidepanel's header row (tabs, open in
 * editor, collapse). The workspace name no longer shows on desktop (⌘K still
 * opens the picker; the mobile header keeps its name). The sidepanel's
 * collapse button lives in its header; once collapsed, the expand button
 * appears at the right end of the tab strip instead. ⌥⌘B toggles it too.
 *
 * The open-in-editor picker renders only in the desktop build (it calls
 * native IPC), and this harness boots the web build in plain Chromium, so its
 * placement is not asserted here. Nor is the tab strip's window-drag region,
 * which only exists in Electron.
 *
 * Architecture (matches the repo's integration doctrine):
 *   - The real production server runs against a fresh tmp `~/.band/`.
 *   - No tRPC mocking. One project with a real directory is seeded so the
 *     workspace route mounts.
 *   - All UI is driven through `WorkspacePage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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

const TOKEN = "e2e-right-panel-header-token";
const PROJECT = "alpha-right-header";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so the desktop layout (sidebars + dockview)
// renders (>= 1024px in useIsDesktop.ts).
test.use({ viewport: { width: 1400, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // A real directory so the default terminal leaf can start its shell.
  const projectPath = join(tmpHome, PROJECT);
  mkdirSync(projectPath, { recursive: true });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: projectPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: projectPath }],
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

test("the center tab strip is the top row, level with the sidebar and sidepanel headers", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  await expect(wp.rightPanelHeader).toBeVisible();
  await expect(wp.sidebarTitleBar).toBeVisible();
  const strip = await wp.boxOf(wp.centerToolbar);
  const sidebarBar = await wp.boxOf(wp.sidebarTitleBar);
  const header = await wp.boxOf(wp.rightPanelHeader);

  // No title bar above the tabs: the strip starts at the top of the window,
  // on the same row as the other two columns' headers.
  expect(strip.y).toBe(0);
  expect(sidebarBar.y).toBe(0);
  expect(header.y).toBe(0);
  // The strip's action slot fills the 38px row less its 1px bottom border.
  expect(Math.abs(strip.height - (header.height - 1))).toBeLessThanOrEqual(1);
  // The desktop title bar's workspace name is gone.
  await expect(wp.desktopTitleWorkspaceNameButton).toHaveCount(0);
});

test("the collapse button lives in the sidepanel header, not the tab strip", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  await expect(wp.rightPanelToggleInHeader).toBeVisible();
  await expect(wp.rightPanelToggleInHeader).toHaveAttribute("aria-pressed", "true");
  await expect(wp.rightPanelToggleInTabStrip).toHaveCount(0);
});

test("collapsing moves the toggle to the tab strip, and expanding moves it back", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  await wp.collapseRightPanelViaHeader();
  await expect(wp.rightPanelToggleInTabStrip).toBeVisible();
  await expect(wp.rightPanelToggleInTabStrip).toHaveAttribute("aria-pressed", "false");

  // With the sidepanel collapsed, the expand button sits at the window's
  // right edge. The collapse runs a 200 ms width transition, so poll until
  // the toggle reaches the viewport edge (1400 px wide).
  await expect
    .poll(async () => {
      const toggle = await wp.boxOf(wp.rightPanelToggleInTabStrip);
      return 1400 - (toggle.x + toggle.width);
    })
    .toBeLessThan(16);

  await wp.expandRightPanelViaTabStrip();
  await expect(wp.rightPanelToggleInHeader).toBeVisible();
  await expect(wp.rightPanelToggleInTabStrip).toHaveCount(0);
});

test("with every tab closed, a drag bar keeps the sidepanel's expand button reachable", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();
  await wp.collapseRightPanelViaHeader();

  // Closing the only tab removes the tab strip, the window's top row.
  await wp.closeTerminalTab(WORKSPACE);
  await expect(wp.tab("terminal")).toHaveCount(0);
  await expect(wp.centerDragBar).toBeVisible();
  const bar = await wp.boxOf(wp.centerDragBar);
  expect(bar.y).toBe(0);

  await wp.rightPanelToggleInDragBar.click();
  await expect(wp.rightPanel).toHaveAttribute("data-visible", "true");
  await expect(wp.rightPanelToggleInDragBar).toHaveCount(0);
});

test("⌥⌘B collapses and expands the right sidepanel", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  await wp.toggleRightPanelViaShortcut();
  await expect(wp.rightPanel).toHaveAttribute("data-visible", "false");
  await expect(wp.rightPanelToggleInTabStrip).toBeVisible();

  await wp.toggleRightPanelViaShortcut();
  await expect(wp.rightPanel).toHaveAttribute("data-visible", "true");
  await expect(wp.rightPanelToggleInHeader).toBeVisible();
});

// Last in the file: the split persists in the workspace's saved layout.
test("with two side-by-side groups, only the outer ones carry the gutter and the expand button", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.openChat(WORKSPACE);
  await wp.clickChatSplitRight(WORKSPACE);
  await expect(wp.centerToolbars).toHaveCount(2);

  await wp.revealRightPanel();
  await wp.collapseRightPanelViaHeader();
  await expect(wp.rightPanelTogglesInTabStrips).toHaveCount(1);
  const [leftGroup, rightGroup] = await Promise.all([
    wp.boxOf(wp.centerToolbars.nth(0)),
    wp.boxOf(wp.centerToolbars.nth(1)),
  ]);
  const outerToolbarX = Math.max(leftGroup.x, rightGroup.x);
  const toggle = await wp.boxOf(wp.rightPanelTogglesInTabStrips);
  expect(toggle.x).toBeGreaterThanOrEqual(outerToolbarX);

  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarGutter).toHaveCount(1);
  const gutter = await wp.boxOf(wp.sidebarGutter);
  expect(gutter.x).toBeLessThan(Math.min(leftGroup.x, rightGroup.x));
});
