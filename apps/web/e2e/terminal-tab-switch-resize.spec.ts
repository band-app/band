/**
 * Switching between terminal tabs sends the PTY no resize (`TerminalSplitLeaf`
 * reports its panes visible only after it has applied the layout for the
 * reveal, and `terminal-cache.ts` sends one deduplicated resize per frame).
 *
 * A TUI redraws on every size change it is signalled about, so a transient
 * size on reveal made Claude Code clear and redraw on each tab switch. The
 * observable here is the `resize` messages on the terminal WebSocket.
 *
 * Real server, real PTYs, driven through `WorktreePage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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

const TOKEN = "e2e-terminal-tab-switch-resize-token";
// One worktree per test: PTYs and terminal tabs outlive a test.
const REPOS = ["tsr-switch", "tsr-resize", "tsr-hidden", "tsr-split"];
const [WT_SWITCH, WT_RESIZE, WT_HIDDEN, WT_SPLIT] = REPOS.map((r) =>
  toWorktreeId(r, "main", "local"),
);

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: REPOS.map((name) => {
      const path = join(tmpHome, name);
      mkdirSync(path, { recursive: true });
      return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
    }),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/** Open the worktree with two terminal tabs, the second one selected. */
async function openTwoTerminalTabs(worktreePage: WorktreePage, worktree: string): Promise<void> {
  await worktreePage.goto(worktree);
  await worktreePage.waitForReady();
  await worktreePage.waitForTerminalReady(20_000);
  await worktreePage.clickTerminalAddTab(worktree);
  await expect(worktreePage.terminalTabs()).toHaveCount(2);
  await expect.poll(() => worktreePage.terminalWrapperCount(worktree), { timeout: 20_000 }).toBe(2);
  await expect(worktreePage.terminalTabVisibilityMarker(worktree, true)).toHaveCount(1);
}

async function switchTabsTwentyTimes(worktreePage: WorktreePage, worktree: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await worktreePage.activateTerminalTab(i % 2);
    await expect(worktreePage.terminalTabVisibilityMarker(worktree, true)).toHaveCount(1);
    await worktreePage.settleFrames();
  }
}

test("switching between terminal tabs 20 times sends no resize", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const resizes = worktreePage.trackTerminalResizeMessages();
  await openTwoTerminalTabs(worktreePage, WT_SWITCH);
  await worktreePage.settleFrames();
  resizes.reset();

  await switchTabsTwentyTimes(worktreePage, WT_SWITCH);

  expect(resizes.sizes()).toEqual([]);
});

test("a window resize while a terminal is visible sends the new size", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const resizes = worktreePage.trackTerminalResizeMessages();
  await openTwoTerminalTabs(worktreePage, WT_RESIZE);
  const colsBefore = await worktreePage.terminalCols(WT_RESIZE);
  resizes.reset();

  await worktreePage.setViewport(1024, 700);

  await expect.poll(() => resizes.sizes().length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => resizes.sizes().at(-1)?.cols, { timeout: 10_000 })
    .toBeLessThan(colsBefore);
});

test("a window resize while a tab is hidden sends one resize with the final size on reveal", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const resizes = worktreePage.trackTerminalResizeMessages();
  await openTwoTerminalTabs(worktreePage, WT_HIDDEN);
  // Show the first tab, leaving the second one hidden.
  await worktreePage.activateTerminalTab(0);
  await worktreePage.settleFrames();
  resizes.reset();
  await worktreePage.setViewport(1024, 700);
  // The visible tab follows the window; wait for that before the reveal.
  await expect.poll(() => resizes.sizes().length, { timeout: 10_000 }).toBeGreaterThan(0);
  await worktreePage.settleFrames();
  resizes.reset();

  await worktreePage.activateTerminalTab(1);
  await expect(worktreePage.terminalTabVisibilityMarker(WT_HIDDEN, true)).toHaveCount(1);
  await worktreePage.settleFrames();

  const finalCols = await worktreePage.terminalCols(WT_HIDDEN);
  const sizes = resizes.sizes();
  expect(sizes).toHaveLength(1);
  expect(sizes[0].cols).toBe(finalCols);
});

test("a split terminal tab sends no resize on switch and follows a window resize", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const resizes = worktreePage.trackTerminalResizeMessages();
  await worktreePage.goto(WT_SPLIT);
  await worktreePage.waitForReady();
  await worktreePage.focusTerminal();
  await expect(worktreePage.terminalPanes()).toHaveCount(1);
  await worktreePage.splitTerminalRight();
  await expect(worktreePage.terminalPanes()).toHaveCount(2);
  // A second terminal tab to switch to; the split tab is the first one.
  await worktreePage.clickTerminalAddTab(WT_SPLIT);
  await expect(worktreePage.terminalTabs()).toHaveCount(2);
  await worktreePage.settleFrames();
  resizes.reset();

  await switchTabsTwentyTimes(worktreePage, WT_SPLIT);
  expect(resizes.sizes()).toEqual([]);

  // The split tab is the first one; the 20th switch left the second selected.
  await worktreePage.activateTerminalTab(0);
  await expect(worktreePage.terminalPanes()).toHaveCount(2);
  await worktreePage.setViewport(1024, 700);
  await expect.poll(() => resizes.sizes().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
});
