/**
 * band-app/band#617 — parking model: full-page navigation between worktrees.
 *
 * Navigating by opening worktree URLs directly (full-page loads), A → B → A,
 * wipes the per-renderer xterm cache each time. The terminal must therefore be
 * restored from the persisted dockview layout (SAME terminalId) and reconnect to
 * the server-kept PTY, replaying scrollback (#613) — it must NOT seed a fresh
 * terminal. This is the reload / catch-up path the parking model must not
 * regress (parking only removes replay for in-session switches).
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

const TOKEN = "e2e-terminal-parking-fullnav-token";

const REPO_A = "alpha-fullnav";
const REPO_B = "bravo-fullnav";
const WORKTREE_A = toWorktreeId(REPO_A, "main", "local");
const WORKTREE_B = toWorktreeId(REPO_B, "main", "local");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
let workdirB!: string;

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
  workdirA = makeGitWorkdir("band-fullnav-a-", tmpHome);
  workdirB = makeGitWorkdir("band-fullnav-b-", tmpHome);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_A,
        path: workdirA,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirA }],
      },
      {
        name: REPO_B,
        path: workdirB,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirB }],
      },
    ],
  });
  // DOM renderer (not WebGL) so printed markers land in `.xterm-rows` for
  // `readTerminalRenderedText` — CI's Chromium has WebGL (canvas → empty rows).
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
});

test.describe("Terminal parking: full-page navigation", () => {
  test("A → B → A via direct URL loads reuses A's terminal id and replays its output", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE_A);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await worktreePage.waitForTerminalReady(20_000);
    await worktreePage.runInTerminal("echo REPRO_MARKER_A");
    await expect
      .poll(
        async () =>
          (await worktreePage.readTerminalRenderedText(WORKTREE_A)).includes("REPRO_MARKER_A"),
        { timeout: 20_000 },
      )
      .toBe(true);
    const idsBefore = await worktreePage.terminalIds(WORKTREE_A);
    expect(idsBefore.length).toBe(1);

    // Full-page navigate to B (fresh renderer, cache wiped).
    await worktreePage.goto(WORKTREE_B);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await worktreePage.waitForTerminalReady(20_000);

    // Full-page navigate back to A.
    await worktreePage.goto(WORKTREE_A);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await worktreePage.waitForTerminalReady(20_000);

    // Same terminalId restored from the persisted layout (not a new terminal).
    await expect
      .poll(() => worktreePage.terminalIds(WORKTREE_A), { timeout: 20_000 })
      .toEqual(idsBefore);
    // And the server-kept PTY's scrollback replayed the earlier output.
    await expect
      .poll(
        async () =>
          (await worktreePage.readTerminalRenderedText(WORKTREE_A)).includes("REPRO_MARKER_A"),
        { timeout: 20_000 },
      )
      .toBe(true);
  });

  test("adding a 2nd terminal, typing, then reloading preserves the active terminal's output", async ({
    page,
  }) => {
    // Repro of a reported flow: open a worktree, add a 2nd terminal via the "+"
    // tab button, run a command, then reload. The persisted layout has BOTH
    // terminals, and the last-active one reconnects to its kept-alive PTY and
    // replays its output on reload — it must not come back as a fresh shell.
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE_A);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await worktreePage.waitForTerminalReady(20_000);

    // Add a 2nd terminal (becomes the active tab) and run a command in it.
    await worktreePage.clickTerminalAddTab(WORKTREE_A);
    await expect
      .poll(() => worktreePage.countTerminalPanels(WORKTREE_A), { timeout: 20_000 })
      .toBe(2);
    await worktreePage.waitForTerminalReady(20_000);
    await worktreePage.runInTerminal("echo SECOND_TERM_MARKER");
    await expect
      .poll(
        async () =>
          (await worktreePage.readTerminalRenderedText(WORKTREE_A)).includes("SECOND_TERM_MARKER"),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Full page reload — the per-renderer cache is wiped; the layout (2 panels)
    // is restored from the server and the active terminal reconnects + replays.
    await worktreePage.reload();
    await worktreePage.waitForReady();
    // No `openTerminalTab()` here: each terminal is its own tab now, and that
    // helper clicks the FIRST one, which would switch away from the restored
    // active tab (the 2nd terminal, holding the marker) that this test is about.
    await worktreePage.waitForTerminalReady(20_000);

    // Both terminals restored, and the active one still shows its output.
    await expect
      .poll(() => worktreePage.countTerminalPanels(WORKTREE_A), { timeout: 20_000 })
      .toBe(2);
    await expect
      .poll(
        async () =>
          (await worktreePage.readTerminalRenderedText(WORKTREE_A)).includes("SECOND_TERM_MARKER"),
        { timeout: 20_000 },
      )
      .toBe(true);
  });
});
