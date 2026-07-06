/**
 * band-app/band#617 — parking model: lifecycle (dispose vs park).
 *
 * The terminal cache is bounded by its OWN LRU (not the panel host's
 * `maxCachedWorkspaces`). The scenarios here pin down when a cached terminal is
 * DISPOSED vs merely PARKED:
 *
 *  1. Closing a terminal tab disposes that terminal's cached xterm (its wrapper
 *     is removed from the DOM entirely), alongside the server-side kill.
 *
 *  2. Switching away with `maxCachedWorkspaces = 1` PARKS the terminal (not
 *     disposed) and returning REUSES it — same terminalId, no new socket, output
 *     intact. This is the reported "terminal re-created on switch" bug.
 *
 *  3. Deleting a workspace disposes its terminals (the only workspace-level
 *     dispose trigger now) via the projects reconcile, while the active
 *     workspace's terminal is untouched.
 *
 *  4. Typing `exit` terminates the shell and keeps the pane without respawning.
 *
 * Real server, real PTYs, driven via `WorkspacePage`. No WebGL needed — this
 * spec asserts on wrapper presence + socket counts, not the render surface.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const TOKEN = "e2e-terminal-parking-dispose-token";

const PROJECT_A = "alpha-parking-dispose";
const PROJECT_B = "bravo-parking-dispose";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");
// A deletable worktree of PROJECT_A (non-default branch — the "Delete workspace"
// menu item is hidden for the default branch). Used by the delete-dispose test.
const FEATURE_BRANCH = "feature";
const WORKSPACE_A_FEATURE = toWorkspaceId(PROJECT_A, FEATURE_BRANCH);

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
let workdirB!: string;
let workdirAFeature!: string;

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function makeGitWorkdir(prefix: string, home: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env = makeGitEnv(home);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdirA = makeGitWorkdir("band-parking-dispose-a-", tmpHome);
  workdirB = makeGitWorkdir("band-parking-dispose-b-", tmpHome);
  // A real second worktree of PROJECT_A on a non-default branch — deletable via
  // the sidebar (unlike the default-branch workspace) so the delete-dispose test
  // can remove it. `git worktree add` off workdirA's repo.
  workdirAFeature = join(tmpHome, "alpha-parking-dispose-feature");
  execFileSync("git", ["worktree", "add", "-b", FEATURE_BRANCH, workdirAFeature], {
    cwd: workdirA,
    env: makeGitEnv(tmpHome),
  });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT_A,
        path: workdirA,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: workdirA },
          { branch: FEATURE_BRANCH, path: workdirAFeature },
        ],
      },
      {
        name: PROJECT_B,
        path: workdirB,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirB }],
      },
    ],
  });
  // Pin the LRU to 1 so a single A→B switch EVICTS A from the panel cache,
  // exercising the "evicted terminal is parked, not disposed" path.
  seedSettings(tmpHome, { tokenSecret: TOKEN, maxCachedWorkspaces: 1 });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdirA) rmSync(workdirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (workdirB) rmSync(workdirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal parking: dispose triggers", () => {
  test("closing a terminal tab disposes its cached instance", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);
    await expect
      .poll(() => workspacePage.terminalWrapperCount(WORKSPACE_A), { timeout: 20_000 })
      .toBe(1);

    // Split so there are two terminals visible side-by-side (both mounted +
    // attached → two wrappers), which also enables the close (×) control.
    await workspacePage.clickTerminalSplitRight(WORKSPACE_A);
    await expect
      .poll(() => workspacePage.countTerminalPanels(WORKSPACE_A), { timeout: 20_000 })
      .toBe(2);
    await expect
      .poll(() => workspacePage.terminalWrapperCount(WORKSPACE_A), { timeout: 20_000 })
      .toBe(2);

    // Close one → its cached xterm is disposed (wrapper removed from the DOM).
    await workspacePage.closeTerminalTab(WORKSPACE_A);
    await expect
      .poll(() => workspacePage.terminalWrapperCount(WORKSPACE_A), { timeout: 20_000 })
      .toBe(1);
  });

  test("switching away with maxCachedWorkspaces=1 parks the terminal and returning reuses it (no re-create)", async ({
    page,
  }) => {
    // This is the exact reported bug: with maxCachedWorkspaces=1, sidebar-
    // switching A → B → A used to tear A's terminal down and bring it back as a
    // fresh/empty shell. The terminal cache now has its OWN LRU bound and is NOT
    // disposed on panel-LRU eviction, so A's terminal is parked and REUSED.
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    // A-scoped socket counter: a reuse opens NO new socket; a re-create would.
    const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);
    const idBefore = await workspacePage.terminalIds(WORKSPACE_A);
    expect(idBefore.length).toBe(1);

    // Produce output we can look for after the round-trip.
    await workspacePage.runInTerminal("echo EVICT_MARKER_A");
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes("EVICT_MARKER_A"),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Switch to B. A is evicted from the panel LRU (its React subtree unmounts),
    // but its terminal must stay alive — PARKED off-screen, not disposed.
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => workspacePage.terminalWrapperCount(WORKSPACE_A), { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(true);

    // Return to A: the SAME parked xterm is re-attached — same terminalId, NO
    // new socket, and the earlier output is still on screen (never re-created).
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(false);
    expect(await workspacePage.terminalIds(WORKSPACE_A)).toEqual(idBefore);
    expect(await workspacePage.readTerminalRenderedText(WORKSPACE_A)).toContain("EVICT_MARKER_A");
    // No reconnect happened — the live socket was reused across the switch.
    expect(socketCount()).toBe(1);
  });

  test("deleting a workspace disposes its cached terminals; the active workspace's are untouched", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Open a terminal in the deletable feature worktree.
    await workspacePage.goto(WORKSPACE_A_FEATURE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A_FEATURE, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);
    await expect
      .poll(() => workspacePage.terminalWrapperCount(WORKSPACE_A_FEATURE), { timeout: 20_000 })
      .toBe(1);

    // Switch to B so the feature workspace is non-active (its terminal parks,
    // still alive) — deleting the ACTIVE workspace is guarded against, so we
    // delete a non-active one to exercise the reconcile dispose path.
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);
    await expect
      .poll(() => workspacePage.terminalWrapperCount(WORKSPACE_A_FEATURE), { timeout: 20_000 })
      .toBe(1);

    // Delete the feature workspace via the sidebar. The projects query refetches
    // without it → `reconcileTerminalWorkspaces` disposes its cached terminal.
    await workspacePage.deleteWorkspaceFromSidebar(WORKSPACE_A_FEATURE);
    await expect
      .poll(() => workspacePage.terminalWrapperCount(WORKSPACE_A_FEATURE), { timeout: 20_000 })
      .toBe(0);
    // The active workspace's terminal is never touched by the reconcile.
    expect(await workspacePage.terminalWrapperCount(WORKSPACE_B)).toBe(1);
  });

  test("typing `exit` terminates the shell and keeps the pane without respawning", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

    // Exit the shell. The server closes the socket with code 1000; the client
    // must treat it as terminated — print a marker, keep the pane, and NOT
    // reconnect (no silent respawn of a fresh shell) per band-app/band#617.
    await workspacePage.runInTerminal("exit");
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes("Process completed"),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Pane (wrapper) is kept, not disposed.
    expect(await workspacePage.terminalWrapperCount(WORKSPACE_A)).toBe(1);

    // Fire the resume path (tab refocus / network back) that a terminated
    // socket used to wrongly reconnect on, then assert NO new socket opens —
    // event-driven (`waitForTerminalSocket` resolves false on timeout), so a
    // regression fails fast rather than relying on a fixed sleep.
    await workspacePage.simulateNetworkOnline();
    expect(await workspacePage.waitForTerminalSocket(WORKSPACE_A, 2000)).toBe(false);
    expect(socketCount()).toBe(1);
  });
});
