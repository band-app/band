/**
 * band-app/band#617 — parking model: full-page navigation between workspaces.
 *
 * Navigating by opening workspace URLs directly (full-page loads), A → B → A,
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

const TOKEN = "e2e-terminal-parking-fullnav-token";

const PROJECT_A = "alpha-fullnav";
const PROJECT_B = "bravo-fullnav";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

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
    projects: [
      {
        name: PROJECT_A,
        path: workdirA,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirA }],
      },
      {
        name: PROJECT_B,
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
    maxCachedWorkspaces: 3,
    useWebGLTerminalRenderer: false,
  });
  server = await startServer({ tmpHome });
});

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
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.runInTerminal("echo REPRO_MARKER_A");
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes("REPRO_MARKER_A"),
        { timeout: 20_000 },
      )
      .toBe(true);
    const idsBefore = await workspacePage.terminalIds(WORKSPACE_A);
    expect(idsBefore.length).toBe(1);

    // Full-page navigate to B (fresh renderer, cache wiped).
    await workspacePage.goto(WORKSPACE_B);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);

    // Full-page navigate back to A.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);

    // Same terminalId restored from the persisted layout (not a new terminal).
    await expect
      .poll(() => workspacePage.terminalIds(WORKSPACE_A), { timeout: 20_000 })
      .toEqual(idsBefore);
    // And the server-kept PTY's scrollback replayed the earlier output.
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes("REPRO_MARKER_A"),
        { timeout: 20_000 },
      )
      .toBe(true);
  });

  // TODO(#643 Phase 5): the add-tab flow is migrated (countTerminalPanels now
  // counts center-term-tab headers), but clicking the `+` new-tab menu button
  // hangs on Playwright's actionability check here — the header `+` appears to
  // be pointer-intercepted in this layout. Re-enable once the `+`-menu click is
  // made robust (or the 2nd terminal is created via Cmd+D split like the
  // dispose spec).
  test.skip("adding a 2nd terminal, typing, then reloading preserves the active terminal's output", async ({
    page,
  }) => {
    // Repro of a reported flow: open a workspace, add a 2nd terminal via the "+"
    // tab button, run a command, then reload. The persisted layout has BOTH
    // terminals, and the last-active one reconnects to its kept-alive PTY and
    // replays its output on reload — it must not come back as a fresh shell.
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);

    // Add a 2nd terminal (becomes the active tab) and run a command in it.
    await workspacePage.clickTerminalAddTab(WORKSPACE_A);
    await expect
      .poll(() => workspacePage.countTerminalPanels(WORKSPACE_A), { timeout: 20_000 })
      .toBe(2);
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.runInTerminal("echo SECOND_TERM_MARKER");
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes(
            "SECOND_TERM_MARKER",
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Full page reload — the per-renderer cache is wiped; the layout (2 panels)
    // is restored from the server and the active terminal reconnects + replays.
    await workspacePage.reload();
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);

    // Both terminals restored, and the active one still shows its output.
    await expect
      .poll(() => workspacePage.countTerminalPanels(WORKSPACE_A), { timeout: 20_000 })
      .toBe(2);
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes(
            "SECOND_TERM_MARKER",
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
  });
});
