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
 *  - one larger than the server's 256 KB hold must run to its end too, so the
 *    page must stop holding it back well before that;
 *  - back-to-back synchronized frames, each output chunk ending one frame and
 *    beginning the next, must each reach the screen. xterm skips a render
 *    while a frame is open, and in that pattern one always is once a chunk is
 *    parsed, so unless the queue holds back the unfinished tail frame, only
 *    xterm's 1 s timeout paints.
 *
 * DOM renderer so the rendered rows are readable. Real server, real PTYs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitEnv } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-visible-output-token";
const REPO = "visible-output";
const WORKTREE = toWorktreeId(REPO, "main");

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
    repos: [
      {
        name: REPO,
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

async function openTerminal(worktreePage: WorktreePage): Promise<void> {
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openTerminalTab();
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE, true)).toBeVisible({
    timeout: 20_000,
  });
  await worktreePage.waitForTerminalReady(20_000);
  await worktreePage.waitForTerminalRenderedPrompt(WORKTREE);
}

test("a visible terminal shows a flood far past the hold threshold through to its end", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const socketCount = worktreePage.trackTerminalSocketOpensFor(WORKTREE);
  await openTerminal(worktreePage);

  // `$((40+2))` keeps the typed command line from matching the marker.
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE,
    "seq 1 600000; echo VISIBLE_DONE_$((40+2))",
    /VISIBLE_DONE_42/,
    { attempts: 1, renderTimeoutMs: 30_000 },
  );
  // Parsed in place, not resynced over a new socket.
  expect(socketCount()).toBe(1);
});

test("a synchronized-output frame that never ends still reaches the screen", async ({ page }) => {
  test.setTimeout(60_000);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await openTerminal(worktreePage);

  // Begin a DEC 2026 frame and never end it. `clear` first, so the result
  // doesn't depend on what an earlier test left on this terminal.
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE,
    "clear; printf '\\033[?2026hSYNC_%s\\n' OPEN_$((40+2))",
    /SYNC_OPEN_42/,
    { attempts: 1, renderTimeoutMs: 10_000 },
  );
});

test("an unfinished synchronized frame larger than the hold threshold still runs to its end", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const socketCount = worktreePage.trackTerminalSocketOpensFor(WORKTREE);
  await openTerminal(worktreePage);

  // ~350 KB inside a frame that never ends: more than the server lets go
  // unacknowledged (256 KB), so the page must not keep holding it.
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE,
    "clear; printf '\\033[?2026h'; seq 1 60000; echo BIG_FRAME_$((40+2))",
    /BIG_FRAME_42/,
    { attempts: 1, renderTimeoutMs: 20_000 },
  );
  expect(socketCount()).toBe(1);
});

test("back-to-back synchronized frames each reach the screen", async ({ page }) => {
  test.setTimeout(60_000);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await openTerminal(worktreePage);
  await worktreePage.recordRenderedTopRow(WORKTREE, "FRAME_(\\d+)");

  // 60 redraws of the top row, ~40 ms apart, the way a fullscreen TUI
  // repaints on each wheel tick: every chunk carries one frame's content, its
  // end marker and the next frame's begin marker. Two animation frames apart,
  // so a loaded runner is unlikely to merge two redraws into one message.
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE,
    "clear; printf '\\033[?2026h'; for i in $(seq 100 159); do " +
      "printf '\\033[HFRAME_%s\\033[?2026l\\033[?2026h' $i; sleep 0.04; done; " +
      "printf '\\033[?2026l\\nFRAMES_DONE_%s\\n' $((40+2))",
    /FRAMES_DONE_42/,
    { attempts: 1, renderTimeoutMs: 20_000 },
  );

  // Measured: all 60 render with the tail held. With no hold, and with whole
  // chunks held until a timer (whose release also ended inside a frame), 1.
  const frames = await worktreePage.readRenderedTopRowMatches();
  expect(frames).toContain("159");
  expect(frames.length).toBeGreaterThanOrEqual(30);
});
