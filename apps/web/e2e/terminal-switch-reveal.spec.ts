/**
 * What a terminal shows in the frames right after its workspace is switched
 * back to (`TerminalPanel.tsx`, `terminal-cache.ts` `attach`,
 * `MultiWorkspacePanelHost.tsx`, `terminal-output-queue.ts` `flush`).
 *
 *  - The frame that reveals the workspace already paints the terminal: its
 *    wrapper is back in the live box with its content, at full opacity. The
 *    host used to fade the incoming workspace in from 0.6 opacity, so a
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
 * driven through `WorkspacePage`. Not covered: the desktop app's
 * `max-active-webgl-contexts` switch, which needs Electron.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-switch-reveal-token";

// One workspace per test holds the terminal under test (PTYs outlive a test,
// so a reused one would carry the previous test's output); all switch away to
// the same empty workspace.
const PROJECT_FIRST_FRAME = "first-frame-reveal";
const PROJECT_RESIZED = "resized-reveal";
const PROJECT_ZOOMED = "zoomed-reveal";
const PROJECT_BACKLOG = "backlog-reveal";
const PROJECT_OTHER = "other-reveal";
const WORKSPACE_FIRST_FRAME = toWorkspaceId(PROJECT_FIRST_FRAME, "main");
const WORKSPACE_RESIZED = toWorkspaceId(PROJECT_RESIZED, "main");
const WORKSPACE_ZOOMED = toWorkspaceId(PROJECT_ZOOMED, "main");
const WORKSPACE_BACKLOG = toWorkspaceId(PROJECT_BACKLOG, "main");
const WORKSPACE_OTHER = toWorkspaceId(PROJECT_OTHER, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
const workdirs = new Map<string, string>();

function makeGitWorkdir(project: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `band-${project}-`)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: gitEnv });
  workdirs.set(project, dir);
  return dir;
}

/** The server-side scrollback of the workspace's only terminal. */
async function serverOutput(workspaceId: string): Promise<string> {
  const { terminals } = await trpcQuery<{ terminals: { terminalId: string }[] }>(
    server.url,
    TOKEN,
    "terminal.list",
    { workspaceId },
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
    projects: [
      PROJECT_FIRST_FRAME,
      PROJECT_RESIZED,
      PROJECT_ZOOMED,
      PROJECT_BACKLOG,
      PROJECT_OTHER,
    ].map((name) => {
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

/** Open a terminal in `workspaceId` and wait for its shell prompt to render. */
async function openTerminal(workspacePage: WorkspacePage, workspaceId: string): Promise<void> {
  await workspacePage.goto(workspaceId);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(workspaceId, true)).toBeVisible({
    timeout: 20_000,
  });
  await workspacePage.waitForTerminalReady(20_000);
  await workspacePage.waitForTerminalRenderedPrompt(workspaceId);
}

/** Switch to the other workspace and wait until `workspaceId`'s terminal is parked. */
async function parkBySwitchingAway(
  workspacePage: WorkspacePage,
  workspaceId: string,
): Promise<void> {
  await workspacePage.switchWorkspace(WORKSPACE_OTHER);
  await expect
    .poll(() => workspacePage.isTerminalParked(workspaceId), { timeout: 20_000 })
    .toBe(true);
}

test("switching back paints the terminal's content in the first frame, at full opacity", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await openTerminal(workspacePage, WORKSPACE_FIRST_FRAME);
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE_FIRST_FRAME,
    `echo FIRST_"FRAME"_MARK`,
    /FIRST_FRAME_MARK/,
  );

  await parkBySwitchingAway(workspacePage, WORKSPACE_FIRST_FRAME);

  await workspacePage.startRevealFrameProbe(WORKSPACE_FIRST_FRAME, "FIRST_FRAME_MARK");
  await workspacePage.switchWorkspace(WORKSPACE_FIRST_FRAME);
  await expect
    .poll(async () => (await workspacePage.readRevealFrames()).length, { timeout: 20_000 })
    .toBe(20);

  const frames = await workspacePage.readRevealFrames();
  // The frame that made the workspace visible painted the terminal with its
  // content, not an empty box filled in a frame later.
  expect(frames[0]).toMatchObject({ attached: true, hasMarker: true });
  // No frame of the reveal dims the terminal (the old 0.6 → 1 fade).
  expect(frames.map((f) => f.opacity)).toEqual(frames.map(() => 1));
});

test("a terminal whose box was resized while parked is refitted on reveal", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await openTerminal(workspacePage, WORKSPACE_RESIZED);
  const wideCols = await workspacePage.terminalCols(WORKSPACE_RESIZED);
  expect(wideCols).toBeGreaterThan(0);

  await parkBySwitchingAway(workspacePage, WORKSPACE_RESIZED);
  await workspacePage.setViewport(1024, 800);
  await workspacePage.switchWorkspace(WORKSPACE_RESIZED);

  // The reveal skips the fit only when the box kept its pixel size; this one
  // shrank, so the grid follows it.
  await expect
    .poll(() => workspacePage.terminalCols(WORKSPACE_RESIZED), { timeout: 20_000 })
    .toBeLessThan(wideCols);
  expect(await workspacePage.isTerminalParked(WORKSPACE_RESIZED)).toBe(false);
});

test("a terminal zoomed while parked is refitted on reveal", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await openTerminal(workspacePage, WORKSPACE_ZOOMED);
  const colsAt100 = await workspacePage.terminalCols(WORKSPACE_ZOOMED);
  expect(colsAt100).toBeGreaterThan(0);

  await parkBySwitchingAway(workspacePage, WORKSPACE_ZOOMED);
  // A parked terminal takes the new font size but defers the fit to its
  // next reveal, which must not take the skip-the-fit path.
  await workspacePage.zoomInBy(2);
  await workspacePage.switchWorkspace(WORKSPACE_ZOOMED);

  await expect
    .poll(() => workspacePage.terminalCols(WORKSPACE_ZOOMED), { timeout: 20_000 })
    .toBeLessThan(colsAt100);
  expect(await workspacePage.isTerminalParked(WORKSPACE_ZOOMED)).toBe(false);
});

test("output queued while parked all lands in order over the same socket on reveal", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_BACKLOG);
  await openTerminal(workspacePage, WORKSPACE_BACKLOG);
  await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

  // ~1.1 MB with the PTY's \r\n, well past the visible drain's 128 KB in flight and under the
  // parked queue's 2 MB cap, printed only once the terminal is parked. The
  // quoted fragments and `$((40+2))` keep the typed command line from
  // matching the markers.
  const gate = join(workdirs.get(PROJECT_BACKLOG) as string, "go");
  await workspacePage.runInTerminalUntilRendered(
    WORKSPACE_BACKLOG,
    `echo GATE_"ARMED"; while [ ! -e ${gate} ]; do sleep 0.1; done; seq 1 150000; echo BACKLOG_DONE_$((40+2))`,
    /GATE_ARMED/,
  );

  await parkBySwitchingAway(workspacePage, WORKSPACE_BACKLOG);
  writeFileSync(gate, "");
  await expect
    .poll(async () => (await serverOutput(WORKSPACE_BACKLOG)).includes("BACKLOG_DONE_42"), {
      timeout: 30_000,
      intervals: [100],
    })
    .toBe(true);

  await workspacePage.switchWorkspace(WORKSPACE_BACKLOG);
  await expect
    .poll(
      async () => {
        const rows = (await workspacePage.readTerminalRenderedRows(WORKSPACE_BACKLOG)).map((r) =>
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
