/**
 * End-to-end coverage for the title-bar row split between the workspace title
 * bar and the right sidepanel (Explorer / Changes).
 *
 * The workspace title bar spans only the center (dockview) column. The right
 * sidepanel runs the full window height, and its header row (tabs, open in
 * editor, collapse) sits level with the title bar. The collapse button lives
 * in that header; once the sidepanel is collapsed, the expand button appears
 * at the title bar's right edge instead.
 *
 * The open-in-editor picker renders only in the desktop build (it calls
 * native IPC), and this harness boots the web build in plain Chromium, so its
 * placement is not asserted here.
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
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-right-panel-header-token";
const PROJECT = "alpha-right-header";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so the desktop layout (title bar + sidebars + dockview)
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

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("the title bar stops at the right sidepanel, whose header sits level with it", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  await expect(wp.rightPanelHeader).toBeVisible();
  const titleBar = await wp.boxOf(wp.workspaceTitleBar);
  const panel = await wp.boxOf(wp.rightPanel);
  const header = await wp.boxOf(wp.rightPanelHeader);

  // The title bar ends before the sidepanel column begins.
  expect(titleBar.x + titleBar.width).toBeLessThanOrEqual(panel.x);
  // The sidepanel reaches the top of the window, and its header shares the
  // title bar's row.
  expect(panel.y).toBe(titleBar.y);
  expect(header.y).toBe(titleBar.y);
  expect(header.height).toBe(titleBar.height);
});

test("the collapse button lives in the sidepanel header, not the title bar", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  await expect(wp.rightPanelToggleInHeader).toBeVisible();
  await expect(wp.rightPanelToggleInHeader).toHaveAttribute("aria-pressed", "true");
  await expect(wp.rightPanelToggleInTitleBar).toHaveCount(0);
});

test("collapsing moves the toggle to the title bar, and expanding moves it back", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  await wp.collapseRightPanelViaHeader();
  await expect(wp.rightPanelToggleInTitleBar).toBeVisible();
  await expect(wp.rightPanelToggleInTitleBar).toHaveAttribute("aria-pressed", "false");

  // With the sidepanel collapsed, the expand button sits at the window's
  // right edge (the title bar now spans the whole center column).
  // The collapse runs a 200 ms width transition, so poll until the bar
  // reaches the viewport edge (1400 px wide, less the 3 px separator).
  await expect
    .poll(async () => {
      const bar = await wp.boxOf(wp.workspaceTitleBar);
      return bar.x + bar.width;
    })
    .toBeGreaterThan(1400 - 8);
  const toggle = await wp.boxOf(wp.rightPanelToggleInTitleBar);
  const titleBar = await wp.boxOf(wp.workspaceTitleBar);
  expect(titleBar.x + titleBar.width - (toggle.x + toggle.width)).toBeLessThan(16);

  await wp.expandRightPanelViaTitleBar();
  await expect(wp.rightPanelToggleInTitleBar).toHaveCount(0);
  await expect(wp.rightPanelToggleInHeader).toBeVisible();
});
