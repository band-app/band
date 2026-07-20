/**
 * On a mobile viewport the terminal panel must always render as a single
 * tabbed group — never split. `MobileWorkspaceLayout`
 * (`workspace.$workspaceId.tsx`) mounts `DockviewTerminalContainer` with
 * `allowSplit={false}`, which:
 *   - hides the "Split right" / "Split down" buttons in the terminal toolbar
 *     (only "New terminal" remains),
 *   - flattens any saved (desktop-created) split layout into one tabbed group
 *     by rebuilding from the live `terminal.list`, and
 *   - never persists the mobile geometry, so the workspace's shared
 *     `terminal_layout` row (the desktop split) survives the visit.
 *
 * Architecture mirrors the other terminal e2e specs: the REAL production
 * `dist/start-server.mjs` boots against a fresh tmp `$HOME` with on-disk git
 * worktrees; no tRPC mocking. Terminals are created through the real
 * `terminal.create` mutation (spawning real PTYs), and the assertions read the
 * rendered DOM (`dockview-terminal__toolbar`, the terminal tab markers) plus the
 * persisted layout via `terminalLayout.get`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

// Narrow viewport — `useIsDesktop()` reports false (threshold 1024px), so the
// workspace renders the mobile tab layout rather than the shared dockview.
test.use({ viewport: { width: 800, height: 900 } });

const TOKEN = "e2e-mobile-tabs-only-token";
const BRANCH = "main";
// Test A uses repo-a, Test B uses repo-b, so PTYs / layouts from one test never
// leak into the other (the server + tmp home are shared across the file).
const REPO_A = "mobile-tabs-repo-a";
const REPO_B = "mobile-tabs-repo-b";

// An arbitrary but split-shaped saved layout. The mobile container ignores its
// geometry (it rebuilds tabs from the live terminal list), so its only role is
// to prove the mobile visit does NOT overwrite the shared row.
const SPLIT_LAYOUT = {
  grid: {
    root: {
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["term-a"], activeView: "term-a", id: "1" }, size: 400 },
        { type: "leaf", data: { views: ["term-b"], activeView: "term-b", id: "2" }, size: 400 },
      ],
    },
    width: 800,
    height: 800,
    orientation: "HORIZONTAL",
  },
  panels: {
    "term-a": { id: "term-a", contentComponent: "terminalTab", title: "Terminal" },
    "term-b": { id: "term-b", contentComponent: "terminalTab", title: "Terminal" },
  },
  activeGroup: "1",
};

let server: ServerHandle;
let tmpHome: string;

function initRepo(name: string): string {
  const repoPath = join(tmpHome, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoAPath = initRepo(REPO_A);
  const repoBPath = initRepo(REPO_B);
  seedState(tmpHome, {
    projects: [
      {
        name: REPO_A,
        path: repoAPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoAPath }],
      },
      {
        name: REPO_B,
        path: repoBPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoBPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  // This spec spawns several real PTYs. `server.close()` resolves when the
  // server (child) exits on SIGTERM, but a slow PTY grandchild only gets
  // SIGKILL at the 5s backstop inside `close()` — it can keep the tmp home
  // non-empty past `cleanupTmpHome`'s ~1s internal retry window, throwing
  // ENOTEMPTY. Retry past that backstop so teardown is deterministic under
  // load (mirrors the terminal-parking flake hardening, #633).
  for (let attempt = 0; ; attempt++) {
    try {
      cleanupTmpHome(tmpHome);
      break;
    } catch (err) {
      if (attempt >= 7) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
});

test.describe("mobile terminal is tabs-only (never split)", () => {
  test("the terminal toolbar offers add-tab but no split controls", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const workspaceId = toWorkspaceId(REPO_A, BRANCH);

    await workspacePage.goto(workspaceId);
    await workspacePage.waitForMobileReady();
    await workspacePage.openMobileTab("Terminal");
    await workspacePage.waitForMobileTerminalReady();

    // Positive anchor: the add-tab affordance is present (proves the toolbar
    // rendered) before asserting the split buttons are absent.
    await expect(workspacePage.mobileTerminalNewButton).toBeVisible();
    await expect(workspacePage.splitRightButtons).toHaveCount(0);
    await expect(workspacePage.splitDownButtons).toHaveCount(0);
  });

  test("multiple terminals render as tabs in one group; desktop split layout is preserved", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const workspaceId = toWorkspaceId(REPO_B, BRANCH);

    // Two live terminals + a saved SPLIT layout, simulating a workspace whose
    // terminals were split on desktop. `terminal.create` itself rewrites the
    // saved layout, so seed the split AFTER creating the terminals.
    await workspacePage.createTerminal(workspaceId, "11111111-1111-4111-8111-111111111111");
    await workspacePage.createTerminal(workspaceId, "22222222-2222-4222-8222-222222222222");
    await workspacePage.saveTerminalLayout(workspaceId, SPLIT_LAYOUT);

    await workspacePage.goto(workspaceId);
    await workspacePage.waitForMobileReady();
    await workspacePage.openMobileTab("Terminal");
    await workspacePage.waitForMobileTerminalReady();

    // Both terminals show up as tabs, and they live in a SINGLE group: exactly
    // one grid toolbar (a split would render one per group) and no split
    // buttons.
    await expect(workspacePage.terminalTabHeaders).toHaveCount(2);
    await expect(workspacePage.mobileTerminalToolbar).toHaveCount(1);
    await expect(workspacePage.splitRightButtons).toHaveCount(0);
    await expect(workspacePage.splitDownButtons).toHaveCount(0);

    // The shared terminal_layout row still holds the desktop split — the mobile
    // visit rendered flattened tabs without persisting over it.
    await expect
      .poll(() => workspacePage.readInnerLayout("terminal", workspaceId))
      .toEqual(SPLIT_LAYOUT);
  });
});
