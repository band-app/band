/**
 * A terminal tab counts as visible only while it is the selected tab of its
 * group (#643).
 *
 * Terminal leaves use dockview's `renderer: "always"`, so an unselected
 * terminal tab stays mounted. `TerminalLeaf` used to pass the workspace-level
 * visibility straight through, so EVERY terminal tab in the active workspace
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
 * project directory (a shell can't start in a path that doesn't exist), real
 * Chromium via `WorkspacePage`. No tRPC mocking, no route interception.
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

const TOKEN = "e2e-terminal-tab-visibility-token";
const PROJECT = "term-tab-visibility";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
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

test("only the selected terminal tab is visible and attached; switching tabs swaps them", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.waitForTerminalReady(20_000);

  // A second terminal tab in the same group; the new one becomes selected.
  await workspacePage.clickTerminalAddTab(WORKSPACE);
  await expect(workspacePage.terminalTabs()).toHaveCount(2);
  await expect
    .poll(() => workspacePage.terminalWrapperCount(WORKSPACE), { timeout: 20_000 })
    .toBe(2);

  // Exactly one tab reports visible, and only its xterm is attached. Before the
  // fix both markers read `true` and neither wrapper was parked.
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE, true)).toHaveCount(1);
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE, false)).toHaveCount(1);
  await expect.poll(() => workspacePage.parkedTerminalCount(WORKSPACE)).toBe(1);
  const [liveBefore] = await workspacePage.liveTerminalIds(WORKSPACE);
  expect(liveBefore).toBeTruthy();

  // Select the other tab: the live terminal swaps, and still only one is live.
  await workspacePage.activateTerminalTab(0);
  await expect
    .poll(async () => {
      const live = await workspacePage.liveTerminalIds(WORKSPACE);
      return live.length === 1 && live[0] !== liveBefore;
    })
    .toBe(true);
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE, true)).toHaveCount(1);
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE, false)).toHaveCount(1);
  expect(await workspacePage.parkedTerminalCount(WORKSPACE)).toBe(1);
});
