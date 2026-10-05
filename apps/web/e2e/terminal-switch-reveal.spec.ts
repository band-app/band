/**
 * What a terminal shows in the frames right after its worktree is switched
 * back to (`TerminalPanel.tsx`, `terminal-cache.ts` `attach`,
 * `MultiWorktreePanelHost.tsx`, `terminal-output-queue.ts` `flush`).
 *
 *  - The frame that reveals the worktree already paints the terminal: its
 *    wrapper is back in the live box with its content, at full opacity. The
 *    host used to fade the incoming worktree in from 0.6 opacity, so a
 *    switch blinked; that half fails on the old code. The attach now runs in
 *    a layout effect instead of a passive one, but a click-driven switch
 *    already ran the passive effect before the next frame, so the
 *    content half passed before too and only guards against a regression.
 *  - A reveal skips the fit when the box kept its pixel size since the last
 *    one. A terminal whose box shrank, or whose font grew with the app zoom,
 *    while parked must still be refitted. These check the outcome, not which
 *    of the reveal fit or the ResizeObserver did it.
 *  - Output that queued up while the terminal was parked all lands, in order,
 *    over the same socket, when the reveal hands it to the paced visible
 *    drain instead of writing it to xterm in one loop.
 *
 * DOM renderer so the rendered rows are readable. Real server, real PTYs,
 * driven through `WorktreePage`. Not covered: the desktop app's
 * `max-active-webgl-contexts` switch, which needs Electron.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitEnv } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-switch-reveal-token";

// One worktree per test holds the terminal under test (PTYs outlive a test,
// so a reused one would carry the previous test's output); all switch away to
// the same empty worktree.
const REPO_FIRST_FRAME = "first-frame-reveal";
const REPO_RESIZED = "resized-reveal";
const REPO_ZOOMED = "zoomed-reveal";
const REPO_BACKLOG = "backlog-reveal";
const REPO_OTHER = "other-reveal";
const WORKTREE_FIRST_FRAME = toWorktreeId(REPO_FIRST_FRAME, "main");
const WORKTREE_RESIZED = toWorktreeId(REPO_RESIZED, "main");
const WORKTREE_ZOOMED = toWorktreeId(REPO_ZOOMED, "main");
const WORKTREE_BACKLOG = toWorktreeId(REPO_BACKLOG, "main");
const WORKTREE_OTHER = toWorktreeId(REPO_OTHER, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
const workdirs = new Map<string, string>();

function makeGitWorkdir(repo: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `band-${repo}-`)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: gitEnv });
  workdirs.set(repo, dir);
  return dir;
}

/** The server-side scrollback of the worktree's only terminal. */
async function serverOutput(worktreeId: string): Promise<string> {
  const { terminals } = await trpcQuery<{ terminals: { terminalId: string }[] }>(
    server.url,
    TOKEN,
    "terminal.list",
    { worktreeId },
  );
  if (terminals.length !== 1) return "";
  const { output } = await trpcQuery<{ output: string }>(server.url, TOKEN, "terminal.output", {
    terminalId: terminals[0].terminalId,
  });
  return output;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: [REPO_FIRST_FRAME, REPO_RESIZED, REPO_ZOOMED, REPO_BACKLOG, REPO_OTHER].map((name) => {
      const path = makeGitWorkdir(name);
      return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
    }),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  for (const dir of workdirs.values()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** Open a terminal in `worktreeId` and wait for its shell prompt to render. */
async function openTerminal(worktreePage: WorktreePage, worktreeId: string): Promise<void> {
  await worktreePage.goto(worktreeId);
  await worktreePage.waitForReady();
  await worktreePage.openTerminalTab();
  await expect(worktreePage.terminalTabVisibilityMarker(worktreeId, true)).toBeVisible({
    timeout: 20_000,
  });
  await worktreePage.waitForTerminalReady(20_000);
  await worktreePage.waitForTerminalRenderedPrompt(worktreeId);
}

/** Switch to the other worktree and wait until `worktreeId`'s terminal is parked. */
async function parkBySwitchingAway(worktreePage: WorktreePage, worktreeId: string): Promise<void> {
  await worktreePage.switchWorktree(WORKTREE_OTHER);
  await expect
    .poll(() => worktreePage.isTerminalParked(worktreeId), { timeout: 20_000 })
    .toBe(true);
}

test("switching back paints the terminal's content in the first frame, at full opacity", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await openTerminal(worktreePage, WORKTREE_FIRST_FRAME);
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE_FIRST_FRAME,
    `echo FIRST_"FRAME"_MARK`,
    /FIRST_FRAME_MARK/,
  );

  await parkBySwitchingAway(worktreePage, WORKTREE_FIRST_FRAME);

  await worktreePage.startRevealFrameProbe(WORKTREE_FIRST_FRAME, "FIRST_FRAME_MARK");
  await worktreePage.switchWorktree(WORKTREE_FIRST_FRAME);
  await expect
    .poll(async () => (await worktreePage.readRevealFrames()).length, { timeout: 20_000 })
    .toBe(20);

  const frames = await worktreePage.readRevealFrames();
  // The frame that made the worktree visible painted the terminal with its
  // content, not an empty box filled in a frame later.
  expect(frames[0]).toMatchObject({ attached: true, hasMarker: true });
  // No frame of the reveal dims the terminal (the old 0.6 → 1 fade).
  expect(frames.map((f) => f.opacity)).toEqual(frames.map(() => 1));
});

test("a terminal whose box was resized while parked is refitted on reveal", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await openTerminal(worktreePage, WORKTREE_RESIZED);
  const wideCols = await worktreePage.terminalCols(WORKTREE_RESIZED);
  expect(wideCols).toBeGreaterThan(0);

  await parkBySwitchingAway(worktreePage, WORKTREE_RESIZED);
  await worktreePage.setViewport(1024, 800);
  await worktreePage.switchWorktree(WORKTREE_RESIZED);

  // The reveal skips the fit only when the box kept its pixel size; this one
  // shrank, so the grid follows it.
  await expect
    .poll(() => worktreePage.terminalCols(WORKTREE_RESIZED), { timeout: 20_000 })
    .toBeLessThan(wideCols);
  expect(await worktreePage.isTerminalParked(WORKTREE_RESIZED)).toBe(false);
});

test("a terminal zoomed while parked is refitted on reveal", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await openTerminal(worktreePage, WORKTREE_ZOOMED);
  const colsAt100 = await worktreePage.terminalCols(WORKTREE_ZOOMED);
  expect(colsAt100).toBeGreaterThan(0);

  await parkBySwitchingAway(worktreePage, WORKTREE_ZOOMED);
  // A parked terminal takes the new font size but defers the fit to its
  // next reveal, which must not take the skip-the-fit path.
  await worktreePage.zoomInBy(2);
  await worktreePage.switchWorktree(WORKTREE_ZOOMED);

  await expect
    .poll(() => worktreePage.terminalCols(WORKTREE_ZOOMED), { timeout: 20_000 })
    .toBeLessThan(colsAt100);
  expect(await worktreePage.isTerminalParked(WORKTREE_ZOOMED)).toBe(false);
});

test("output queued while parked all lands in order over the same socket on reveal", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const socketCount = worktreePage.trackTerminalSocketOpensFor(WORKTREE_BACKLOG);
  await openTerminal(worktreePage, WORKTREE_BACKLOG);
  await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

  // ~1.1 MB with the PTY's \r\n, well past the visible drain's 128 KB in flight and under the
  // parked queue's 2 MB cap, printed only once the terminal is parked. The
  // quoted fragments and `$((40+2))` keep the typed command line from
  // matching the markers.
  const gate = join(workdirs.get(REPO_BACKLOG) as string, "go");
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE_BACKLOG,
    `echo GATE_"ARMED"; while [ ! -e ${gate} ]; do sleep 0.1; done; seq 1 150000; echo BACKLOG_DONE_$((40+2))`,
    /GATE_ARMED/,
  );

  await parkBySwitchingAway(worktreePage, WORKTREE_BACKLOG);
  writeFileSync(gate, "");
  await expect
    .poll(async () => (await serverOutput(WORKTREE_BACKLOG)).includes("BACKLOG_DONE_42"), {
      timeout: 30_000,
      intervals: [100],
    })
    .toBe(true);

  await worktreePage.switchWorktree(WORKTREE_BACKLOG);
  await expect
    .poll(
      async () => {
        const rows = (await worktreePage.readTerminalRenderedRows(WORKTREE_BACKLOG)).map((r) =>
          r.trim(),
        );
        const done = rows.indexOf("BACKLOG_DONE_42");
        return done >= 2 ? rows.slice(done - 2, done + 1) : null;
      },
      { timeout: 20_000 },
    )
    .toEqual(["149999", "150000", "BACKLOG_DONE_42"]);
  // Parsed in place, not dropped and resynced over a new socket.
  expect(socketCount()).toBe(1);
});
