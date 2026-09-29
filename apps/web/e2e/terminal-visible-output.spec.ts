/**
 * Output of a visible terminal (`src/lib/terminal-output-queue.ts`).
 *
 * A visible terminal writes through a paced drain and acknowledges each
 * chunk once xterm has parsed it; the server pauses the PTY while more than
 * 256 KB is unacknowledged (`api/terminals/output-flow.ts`). These cover ways
 * visible output could stall or arrive in batches:
 *
 *  - a flood far past the hold threshold must run to the end at full speed
 *    over the same socket. If the page stopped acknowledging, every 256 KB
 *    would wait out the server's 5 s stall timeout, and this ~4 MB flood
 *    would take over a minute;
 *  - a DEC 2026 synchronized-output frame whose end marker never comes must
 *    still reach the screen (xterm stops deferring its render after 1 s);
 *  - back-to-back synchronized frames, each output chunk ending one frame and
 *    beginning the next, must reach xterm chunk by chunk. The page used to
 *    hold visible output while a frame was open, and in that pattern a frame
 *    is always open, so only a 250 ms timer let redraws through.
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

test("back-to-back synchronized frames reach xterm one chunk at a time", async ({ page }) => {
  test.setTimeout(60_000);
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await openTerminal(workspacePage);
  await workspacePage.recordParsedTopRow(WORKSPACE, "FRAME_(\\d+)");

  // 60 redraws of the top row, ~20 ms apart, the way a fullscreen TUI repaints
  // on each wheel tick: every chunk carries one frame's content, its end
  // marker and the next frame's begin marker.
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE,
    "clear; printf '\\033[?2026h'; for i in $(seq 100 159); do " +
      "printf '\\033[HFRAME_%s\\033[?2026l\\033[?2026h' $i; sleep 0.02; done; " +
      "printf '\\033[?2026l\\nFRAMES_DONE_%s\\n' $((40+2))",
    /FRAMES_DONE_42/,
    { attempts: 1, renderTimeoutMs: 20_000 },
  );

  // Parsed chunk by chunk, xterm sees nearly every frame on its own. Held
  // until a timer, it saw one frame per ~250 ms: 14 of the 60 before the fix.
  const frames = await workspacePage.readParsedTopRowMatches();
  expect(frames).toContain("159");
  expect(frames.length).toBeGreaterThanOrEqual(30);
});
