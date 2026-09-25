/**
 * A terminal survives a restart of the web server.
 *
 * Terminal PTYs live in the detached terminal daemon, not the server, so a
 * restart (desktop relaunch, auto-update, crash) keeps every shell running.
 * This drives that end to end through the real UI:
 *
 *   1. Type into the terminal: set a shell variable and print a marker.
 *   2. Restart the server on the same home and port, leaving the daemon up.
 *   3. Reload the page. A fresh xterm has nothing on screen except what the
 *      server replays, so the marker showing up proves the daemon's screen
 *      snapshot came back.
 *   4. Echo the variable into a file. Only the ORIGINAL shell has it set, so
 *      the file's contents prove the terminal is still attached to that same
 *      shell and still accepts input.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { stopTerminalDaemon } from "../tests/helpers/terminal-daemon";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-restart-token";
const PROJECT = "alpha-terminal-restart";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const SHELL_VALUE = "band-restart-shell-4b1d";

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (which hosts the terminal container) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
/** A real directory for the project: the PTY spawns with it as cwd. */
let workdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-term-restart-")));
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: workdir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdir }],
      },
    ],
  });
  // The DOM renderer puts the rendered glyphs in `.xterm-rows`, where the
  // page object can read them; WebGL would draw to a canvas.
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  // If `restart()` threw midway, `server` is the old handle and a new server's
  // daemon may still run; stop whatever serves this home before deleting it.
  await stopTerminalDaemon(tmpHome);
  cleanupTmpHome(tmpHome);
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function readFileOrNull(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf-8").trim() : null;
}

test("a terminal keeps its shell and its screen across a server restart", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const afterFile = join(workdir, "after-restart.txt");

  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await workspacePage.waitForTerminalReady();
  await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE);

  // The quotes keep the typed line's own echo from matching the marker.
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE,
    `SHELL_VALUE=${SHELL_VALUE}; echo BEFORE_"RESTART"`,
    /BEFORE_RESTART/,
  );

  server = await server.restart();

  // Fresh page: its xterm starts empty, so anything on screen was replayed.
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await workspacePage.waitForTerminalReady();
  await expect
    .poll(() => workspacePage.readTerminalRenderedText(WORKSPACE), { timeout: 20_000 })
    .toMatch(/BEFORE_RESTART/);

  // Same shell, still taking input: only it has SHELL_VALUE set.
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE,
    `echo $SHELL_VALUE>${afterFile}; echo AFTER_"RESTART"`,
    /AFTER_RESTART/,
  );
  await expect.poll(() => readFileOrNull(afterFile)).toBe(SHELL_VALUE);
});
