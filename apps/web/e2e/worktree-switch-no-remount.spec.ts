/**
 * Returning to any previously visited worktree is instant: its center
 * dockview was never unmounted, so there is no layout restore, no refetch and
 * no terminal reconnect. `MultiWorktreePanelHost` keeps every visited
 * worktree mounted (orca's mounted-worktree set); it used to keep an LRU of 3,
 * so visiting five others and coming back remounted the first.
 *
 * Proof of "not remounted": a mark set on the worktree's mounted entry
 * element survives the round trip, and so does a mark on its terminal
 * wrapper, with no second terminal socket. DOM renderer (not WebGL) so
 * printed output lands in `.xterm-rows` where `readTerminalRenderedText` can
 * read it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-switch-no-remount-token";
const REPO = "no-remount-repo";
const BRANCHES = ["nr-0", "nr-1", "nr-2", "nr-3", "nr-4", "nr-5"];
const WS = BRANCHES.map((branch) => toWorktreeId(REPO, branch));

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# no remount\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  const worktrees = [{ branch: "main", path: repoPath }];
  for (const branch of BRANCHES) {
    const path = join(tmpHome, `${REPO}-${branch}`);
    gitInHome(repoPath, ["worktree", "add", "-q", "-b", branch, path], tmpHome);
    worktrees.push({ branch, path });
  }
  seedState(tmpHome, {
    repos: [{ name: REPO, path: repoPath, defaultBranch: "main", worktrees }],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test("returning to the first of six visited worktrees does not remount it", async ({ page }) => {
  const [first, ...others] = WS;
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const socketOpens = worktreePage.trackTerminalSocketOpensFor(first);
  // The fake clock only measures here: `first` becomes the oldest of five
  // hidden worktrees, and past 30 s hidden the cold-park policy would
  // legitimately dispose its terminal, which is not what this test checks.
  await worktreePage.installClock();

  await worktreePage.goto(first);
  await worktreePage.waitForReady();
  await worktreePage.openTerminalTab();
  await expect(worktreePage.terminalTabVisibilityMarker(first, true)).toBeVisible({
    timeout: 20_000,
  });
  await worktreePage.waitForTerminalRenderedPrompt(first);
  await worktreePage.runInTerminalUntilRendered(first, "echo NO_REMOUNT_$((6*7))", /NO_REMOUNT_42/);
  await expect.poll(() => socketOpens(), { timeout: 20_000 }).toBe(1);
  await worktreePage.markMountedWorktree(first);
  expect(await worktreePage.markTerminalWrappers(first)).toBe(1);

  const firstHiddenAt = await worktreePage.clockNow();
  for (const id of others) {
    await worktreePage.switchWorktree(id);
    await expect(worktreePage.cachedPanelEntries(id)).toBeVisible();
  }

  await worktreePage.switchWorktree(first);
  await expect(worktreePage.terminalTabVisibilityMarker(first, true)).toBeVisible();
  expect((await worktreePage.clockNow()) - firstHiddenAt).toBeLessThan(29_000);

  expect(await worktreePage.isMountedWorktreeMarked(first)).toBe(true);
  // Only the shown worktree takes focus; the one just left is inert.
  await expect(worktreePage.cachedPanelEntries(first)).not.toHaveAttribute("inert");
  await expect(worktreePage.cachedPanelEntries(others[others.length - 1])).toHaveAttribute("inert");
  expect(await worktreePage.markedTerminalWrapperCount(first)).toBe(1);
  expect(await worktreePage.readTerminalRenderedText(first)).toContain("NO_REMOUNT_42");
  expect(socketOpens()).toBe(1);
});
