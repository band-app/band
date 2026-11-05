/**
 * The macOS swipe gesture steps worktree history in the desktop app. The
 * trackpad cannot be driven from a test, so the spec emits the BrowserWindow
 * `swipe` event from the main process, which is what Electron does when
 * "Swipe between pages" is on.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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

const REPOS = ["swipe-a", "swipe-b"];
const [WT_A, WT_B] = REPOS.map((r) => toWorktreeId(r, "main", "local"));

let home: string;
let desktop: LaunchedDesktop | undefined;

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  if (home) cleanupTmpHome(home);
});

test("S2: swipe right goes back a worktree and swipe left goes forward", async () => {
  home = createTmpHome();
  seedState(home, {
    repos: REPOS.map((name) => {
      const path = join(home, name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "README.md"), "# swipe\n");
      git(path, ["init", "-b", "main"]);
      git(path, ["add", "."]);
      git(path, ["commit", "-m", "initial"]);
      return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
    }),
  });
  const port = await getRandomPort();
  seedSettings(home, { tokenSecret: "desktop-swipe-token", webServerPort: port });
  desktop = await launchDesktop({ home, hubPort: port });
  await desktop.closeDevTools();
  const dashboard = new DesktopDashboardPage(desktop.window);

  await dashboard.gotoDeepLink(WT_A);
  await dashboard.switchWorktree(REPOS[1], WT_B);
  await expect.poll(() => dashboard.url()).toContain(encodeURIComponent(WT_B));

  await desktop.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].emit("swipe", {}, "right");
  });
  await expect.poll(() => dashboard.url()).toContain(encodeURIComponent(WT_A));

  await desktop.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].emit("swipe", {}, "left");
  });
  await expect.poll(() => dashboard.url()).toContain(encodeURIComponent(WT_B));
});
