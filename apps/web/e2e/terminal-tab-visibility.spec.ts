/**
 * A terminal tab counts as visible only while it is the selected tab of its
 * group (#643).
 *
 * Terminal leaves use dockview's `renderer: "always"`, so an unselected
 * terminal tab stays mounted. `TerminalLeaf` used to pass the worktree-level
 * visibility straight through, so EVERY terminal tab in the active worktree
 * believed it was on screen: all stayed attached (never parked, so the
 * parked-terminal LRU could never evict them), all grabbed ⌃` focus, and an
 * "Add to Terminal" reference without a terminalId was typed into all of them.
 * It now folds in the panel's own `isVisible`.
 *
 * Observable here through the DOM: each leaf's `center-term-leaf__visible-*`
 * marker, and whether each terminal's persistent xterm wrapper is attached to a
 * live panel or sits in the off-screen parking container.
 *
 * Architecture (repo integration doctrine): real production server, a real
 * repo directory (a shell can't start in a path that doesn't exist), real
 * Chromium via `WorktreePage`. No tRPC mocking, no route interception.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-tab-visibility-token";
const REPO = "term-tab-visibility";
const WORKTREE = toWorktreeId(REPO, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
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

test("only the selected terminal tab is visible and attached; switching tabs swaps them", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.waitForTerminalReady(20_000);

  // A second terminal tab in the same group; the new one becomes selected.
  await worktreePage.clickTerminalAddTab(WORKTREE);
  await expect(worktreePage.terminalTabs()).toHaveCount(2);
  await expect.poll(() => worktreePage.terminalWrapperCount(WORKTREE), { timeout: 20_000 }).toBe(2);

  // Exactly one tab reports visible, and only its xterm is attached. Before the
  // fix both markers read `true` and neither wrapper was parked.
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE, true)).toHaveCount(1);
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE, false)).toHaveCount(1);
  await expect.poll(() => worktreePage.parkedTerminalCount(WORKTREE)).toBe(1);
  const [liveBefore] = await worktreePage.liveTerminalIds(WORKTREE);
  expect(liveBefore).toBeTruthy();

  // Select the other tab: the live terminal swaps, and still only one is live.
  await worktreePage.activateTerminalTab(0);
  await expect
    .poll(async () => {
      const live = await worktreePage.liveTerminalIds(WORKTREE);
      return live.length === 1 && live[0] !== liveBefore;
    })
    .toBe(true);
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE, true)).toHaveCount(1);
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE, false)).toHaveCount(1);
  expect(await worktreePage.parkedTerminalCount(WORKTREE)).toBe(1);
});
