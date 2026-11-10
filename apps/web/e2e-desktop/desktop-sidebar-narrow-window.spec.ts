/**
 * Panel widths are kept as a share of the window, and the sidebar has a minimum width. Shrinking
 * a wide window took the sidebar below that minimum, the panel library collapsed it, and Band
 * saved the collapse as if the user had hidden the sidebar, so it stayed hidden (docked DevTools
 * on a slow CI runner squeezed the page the same way). A collapse the layout makes is not the
 * user's: the sidebar reopens as soon as there is room and a reload keeps it open.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { git } from "../e2e/helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  seedSettings,
  seedState,
} from "../e2e/helpers/server";
import { type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";

const REPO = "narrow";

let home: string;
let desktop: LaunchedDesktop | undefined;

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  if (home) cleanupTmpHome(home);
});

async function launch(): Promise<DesktopDashboardPage> {
  home = createTmpHome();
  const path = join(home, REPO);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# narrow\n");
  git(path, ["init", "-b", "main"]);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  seedState(home, {
    repos: [{ name: REPO, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] }],
  });
  const port = await getRandomPort();
  seedSettings(home, { tokenSecret: "desktop-narrow-token", webServerPort: port });
  desktop = await launchDesktop({ home, hubPort: port });
  await desktop.closeDevTools();
  const dashboard = new DesktopDashboardPage(desktop.window);
  await dashboard.expectRepoListed(REPO);
  return dashboard;
}

test("shrinking a wide window keeps the sidebar open, also after a reload", async () => {
  const dashboard = await launch();
  await desktop?.resizeWindow(1800, 900);
  await dashboard.expectSidebarOpen();

  await desktop?.resizeWindow(900, 800);
  await dashboard.expectSidebarOpen();
  await expect(dashboard.repoHeader(REPO)).toBeVisible();

  await dashboard.reload();
  await dashboard.expectSidebarOpen();
});

test("a sidebar the user hides stays hidden after a reload", async () => {
  const dashboard = await launch();
  await desktop?.resizeWindow(1200, 800);
  await dashboard.expectSidebarOpen();

  await dashboard.toggleSidebar();
  await dashboard.expectSidebarCollapsed();

  await dashboard.reload();
  await dashboard.expectSidebarCollapsed();
});
