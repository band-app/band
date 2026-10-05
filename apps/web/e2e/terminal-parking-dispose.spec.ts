/**
 * band-app/band#617 — parking model: lifecycle (dispose vs park).
 *
 * The scenarios here pin down when a cached terminal is DISPOSED vs merely
 * PARKED (the time-based renderer policy has its own spec,
 * `terminal-park-policy.spec.ts`):
 *
 *  1. Closing a terminal tab disposes that terminal's cached xterm (its wrapper
 *     is removed from the DOM entirely), alongside the server-side kill.
 *
 *  2. Switching away PARKS the terminal (not disposed) and returning REUSES it
 *     — same terminalId, no new socket, output intact. This is the reported
 *     "terminal re-created on switch" bug.
 *
 *  3. Deleting a worktree disposes its terminals (the only worktree-level
 *     dispose trigger now) via the repos reconcile, while the active
 *     worktree's terminal is untouched.
 *
 *  4. Typing `exit` terminates the shell and keeps the pane without respawning.
 *
 * Real server, real PTYs, driven via `WorktreePage`. No WebGL needed — this
 * spec asserts on wrapper presence + socket counts, not the render surface.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const TOKEN = "e2e-terminal-parking-dispose-token";

// Each test uses its own worktree(s): server-side PTYs + persisted dockview
// layouts survive across tests in a file, so a test that mutates a worktree
// (e.g. the split in the close-tab test) must not share it with another.
const REPO_A = "alpha-parking-dispose";
const REPO_B = "bravo-parking-dispose";
const WORKTREE_A = toWorktreeId(REPO_A, "main");
const WORKTREE_B = toWorktreeId(REPO_B, "main");
// A deletable worktree of REPO_A (non-default branch — the "Delete worktree"
// menu item is hidden for the default branch). Used by the delete-dispose test.
const FEATURE_BRANCH = "feature";
const WORKTREE_A_FEATURE = toWorktreeId(REPO_A, FEATURE_BRANCH);
// Dedicated worktree for the close-tab test (it splits, mutating the layout).
const REPO_CLOSE = "charlie-parking-dispose";
const WORKTREE_CLOSE = toWorktreeId(REPO_CLOSE, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
let workdirB!: string;
let workdirAFeature!: string;
let workdirClose!: string;

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
  workdirClose = makeGitWorkdir("band-parking-dispose-close-", tmpHome);
  // A real second worktree of REPO_A on a non-default branch — deletable via
  // the sidebar (unlike the default-branch worktree) so the delete-dispose test
  // can remove it. `git worktree add` off workdirA's repo.
  workdirAFeature = join(tmpHome, "alpha-parking-dispose-feature");
  execFileSync("git", ["worktree", "add", "-b", FEATURE_BRANCH, workdirAFeature], {
    cwd: workdirA,
    env: makeGitEnv(tmpHome),
  });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_A,
        path: workdirA,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: workdirA },
          { branch: FEATURE_BRANCH, path: workdirAFeature },
        ],
      },
      {
        name: REPO_B,
        path: workdirB,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirB }],
      },
      {
        name: REPO_CLOSE,
        path: workdirClose,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirClose }],
      },
    ],
  });
  // `useWebGLTerminalRenderer: false` forces xterm's DOM renderer so the printed
  // output lands in `.xterm-rows` where `readTerminalRenderedText` can read it —
  // CI's Chromium has WebGL, which otherwise renders to a canvas (empty rows).
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    useWebGLTerminalRenderer: false,
  });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdirA) rmSync(workdirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (workdirB) rmSync(workdirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (workdirClose)
    rmSync(workdirClose, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal parking: dispose triggers", () => {
  test("closing a terminal tab disposes its cached instance", async ({ page }) => {
    // Dedicated worktree — this test splits (mutating the layout), so it must
    // not share a worktree with the other tests.
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE_CLOSE);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_CLOSE, true)).toBeVisible({
      timeout: 20_000,
    });
    await worktreePage.waitForTerminalReady(20_000);
    await expect
      .poll(() => worktreePage.terminalWrapperCount(WORKTREE_CLOSE), { timeout: 20_000 })
      .toBe(1);

    // Split the terminal into a nested PANE (⌘D from inside the focused
    // terminal) → two panes side-by-side in ONE terminal tab, both mounted +
    // attached (two cached xterm wrappers). A split is a pane now, not a new
    // terminal tab, so the tab count stays 1.
    await worktreePage.focusTerminal();
    await worktreePage.splitTerminalRight();
    await expect
      .poll(() => worktreePage.terminalWrapperCount(WORKTREE_CLOSE), { timeout: 20_000 })
      .toBe(2);
    await expect
      .poll(() => worktreePage.countTerminalPanels(WORKTREE_CLOSE), { timeout: 20_000 })
      .toBe(1);

    // Close the focused pane (Ctrl+D) → its cached xterm is disposed (wrapper
    // removed from the DOM).
    await worktreePage.closeFocusedPane();
    await expect
      .poll(() => worktreePage.terminalWrapperCount(WORKTREE_CLOSE), { timeout: 20_000 })
      .toBe(1);
  });

  test("switching away parks the terminal and returning reuses it (no re-create)", async ({
    page,
  }) => {
    // This is the reported bug: sidebar-switching A → B → A used to tear A's
    // terminal down and bring it back as a fresh/empty shell. A's terminal is
    // now parked on switch-away and REUSED on return.
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    // A-scoped socket counter: a reuse opens NO new socket; a re-create would.
    const socketCount = worktreePage.trackTerminalSocketOpensFor(WORKTREE_A);

    await worktreePage.goto(WORKTREE_A);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await worktreePage.waitForTerminalReady(20_000);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);
    const idBefore = await worktreePage.terminalIds(WORKTREE_A);
    expect(idBefore.length).toBe(1);

    // Produce output we can look for after the round-trip.
    await worktreePage.runInTerminal("echo PARK_MARKER_A");
    await expect
      .poll(
        async () =>
          (await worktreePage.readTerminalRenderedText(WORKTREE_A)).includes("PARK_MARKER_A"),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Switch to B. A's worktree stays mounted but hidden, and its terminal
    // must stay alive — PARKED off-screen, not disposed.
    await worktreePage.switchWorktree(WORKTREE_B);
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => worktreePage.terminalWrapperCount(WORKTREE_A), { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(() => worktreePage.isTerminalParked(WORKTREE_A), { timeout: 20_000 })
      .toBe(true);

    // Return to A: the SAME parked xterm is re-attached — same terminalId, NO
    // new socket, and the earlier output is still on screen (never re-created).
    await worktreePage.switchWorktree(WORKTREE_A);
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => worktreePage.isTerminalParked(WORKTREE_A), { timeout: 20_000 })
      .toBe(false);
    expect(await worktreePage.terminalIds(WORKTREE_A)).toEqual(idBefore);
    expect(await worktreePage.readTerminalRenderedText(WORKTREE_A)).toContain("PARK_MARKER_A");
    // No reconnect happened — the live socket was reused across the switch.
    expect(socketCount()).toBe(1);
  });

  test("deleting a worktree disposes its cached terminals; the active worktree's are untouched", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Open a terminal in the deletable feature worktree.
    await worktreePage.goto(WORKTREE_A_FEATURE);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_A_FEATURE, true)).toBeVisible({
      timeout: 20_000,
    });
    await worktreePage.waitForTerminalReady(20_000);
    await expect
      .poll(() => worktreePage.terminalWrapperCount(WORKTREE_A_FEATURE), { timeout: 20_000 })
      .toBe(1);

    // Switch to B so the feature worktree is non-active (its terminal parks,
    // still alive) — deleting the ACTIVE worktree is guarded against, so we
    // delete a non-active one to exercise the reconcile dispose path.
    await worktreePage.switchWorktree(WORKTREE_B);
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await worktreePage.waitForTerminalReady(20_000);
    await expect
      .poll(() => worktreePage.terminalWrapperCount(WORKTREE_A_FEATURE), { timeout: 20_000 })
      .toBe(1);

    // Delete the feature worktree via the sidebar. The repos query refetches
    // without it → `reconcileTerminalWorktrees` disposes its cached terminal.
    await worktreePage.deleteWorktreeFromSidebar(WORKTREE_A_FEATURE);
    await expect
      .poll(() => worktreePage.terminalWrapperCount(WORKTREE_A_FEATURE), { timeout: 20_000 })
      .toBe(0);
    // The active worktree's terminal is never touched by the reconcile.
    expect(await worktreePage.terminalWrapperCount(WORKTREE_B)).toBe(1);
  });

  test("typing `exit` terminates the shell and keeps the pane without respawning", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const socketCount = worktreePage.trackTerminalSocketOpensFor(WORKTREE_A);

    await worktreePage.goto(WORKTREE_A);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await worktreePage.waitForTerminalReady(20_000);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

    // Exit the shell. The server closes the socket with code 1000; the client
    // must treat it as terminated — print a marker, keep the pane, and NOT
    // reconnect (no silent respawn of a fresh shell) per band-app/band#617.
    await worktreePage.runInTerminal("exit");
    await expect
      .poll(
        async () =>
          (await worktreePage.readTerminalRenderedText(WORKTREE_A)).includes("Process completed"),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Pane (wrapper) is kept, not disposed.
    expect(await worktreePage.terminalWrapperCount(WORKTREE_A)).toBe(1);

    // Fire the resume path (tab refocus / network back) that a terminated
    // socket used to wrongly reconnect on, then assert NO new socket opens —
    // event-driven (`waitForTerminalSocket` resolves false on timeout), so a
    // regression fails fast rather than relying on a fixed sleep.
    await worktreePage.simulateNetworkOnline();
    expect(await worktreePage.waitForTerminalSocket(WORKTREE_A, 2000)).toBe(false);
    expect(socketCount()).toBe(1);
  });
});
