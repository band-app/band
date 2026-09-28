/**
 * Output of a visible terminal (`src/lib/terminal-output-queue.ts`).
 *
 * A visible terminal writes through a paced drain and acknowledges each
 * chunk once xterm has parsed it; the server pauses the PTY while more than
 * 256 KB is unacknowledged (`api/terminals/output-flow.ts`). These cover the
 * two ways that could leave a pane stuck:
 *
 *  - a flood far past the hold threshold must run to the end at full speed
 *    over the same socket. If the page stopped acknowledging, every 256 KB
 *    would wait out the server's 5 s stall timeout, and this ~4 MB flood
 *    would take over a minute;
 *  - a DEC 2026 synchronized-output frame whose end marker never comes must
 *    still reach the screen once the hold times out.
 *
 * DOM renderer so the rendered rows are readable. Real server, real PTYs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitEnv } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-visible-output-token";
const PROJECT = "visible-output";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let workdir!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-visible-output-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workdir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: workdir,
    env: gitEnv,
  });
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
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function openTerminal(workspacePage: WorkspacePage): Promise<void> {
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE, true)).toBeVisible({
    timeout: 20_000,
  });
  await workspacePage.waitForTerminalReady(20_000);
  await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE);
}

test("a visible terminal shows a flood far past the hold threshold through to its end", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE);
  await openTerminal(workspacePage);

  // `$((40+2))` keeps the typed command line from matching the marker.
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE,
    "seq 1 600000; echo VISIBLE_DONE_$((40+2))",
    /VISIBLE_DONE_42/,
    { attempts: 1, renderTimeoutMs: 30_000 },
  );
  // Parsed in place, not resynced over a new socket.
  expect(socketCount()).toBe(1);
});

test("a synchronized-output frame that never ends still reaches the screen", async ({ page }) => {
  test.setTimeout(60_000);
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await openTerminal(workspacePage);

  // Begin a DEC 2026 frame and never end it. `clear` first, so the result
  // doesn't depend on what an earlier test left on this terminal.
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE,
    "clear; printf '\\033[?2026hSYNC_%s\\n' OPEN_$((40+2))",
    /SYNC_OPEN_42/,
    { attempts: 1, renderTimeoutMs: 10_000 },
  );
});
