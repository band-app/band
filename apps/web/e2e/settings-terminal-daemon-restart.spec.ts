/**
 * "Restart terminal service" (Settings > Terminal) ends every open terminal.
 *
 * Drives the real UI: open a terminal, restart the terminal service from
 * Settings, and confirm the pane shows the process as finished — the same
 * on-screen state a terminal shows after any other PTY exit (see
 * `terminal-cache.ts`). The daemon lifecycle (which process gets killed,
 * that a retired daemon is untouched, that a reopened terminal is
 * cold-restored) is covered at the tRPC/WS layer in
 * `apps/hub/tests/terminal-restart-daemon.test.ts` and
 * `terminal-cold-restore.test.ts` — this spec covers only the DOM-observable
 * half: clicking the button in Settings actually ends the terminal.
 */

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
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-daemon-restart-token";
const PROJECT = "alpha-terminal-daemon-restart";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (which hosts both the terminal container and the persistent bottom action
// bar with the Settings button) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let workdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-term-daemon-restart-")));
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
  // The DOM renderer puts rendered glyphs in `.xterm-rows`, where the page
  // object can read them; WebGL would draw to a canvas.
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("restarting the terminal service from Settings ends the open terminal", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const settingsPage = new SettingsPage(page, server.url, TOKEN);

  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await workspacePage.waitForTerminalReady();
  await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE);
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE,
    'echo BEFORE_"RESTART"',
    /BEFORE_RESTART/,
  );

  await settingsPage.openDialog();
  await settingsPage.expectRowVisible(settingsPage.restartTerminalServiceButton());
  await settingsPage.restartTerminalService();

  // Same close code (1000) and on-screen marker as any other PTY exit.
  await expect
    .poll(() => workspacePage.readTerminalRenderedText(WORKSPACE), { timeout: 15_000 })
    .toMatch(/Process completed/);
});
