/**
 * Reconnect replay width-sync (reflow-scatter regression).
 *
 * Bug: after reloading the web app, a reconnecting terminal renders its
 * scrollback with a wrapped TUI paragraph broken across the wrong columns —
 * words scattered onto rows they don't belong on. A second reload renders
 * correctly. Root cause: the server replayed a `serialize()` snapshot taken at
 * the headless mirror's width, but that width didn't match the client's render
 * width at the moment the snapshot was written, so xterm's wrapped-line reflow
 * scattered the cells. This is a WIDTH-MISMATCH bug, not a rendering bug.
 *
 * Fix: replay is request-driven. The client asks for the snapshot only once
 * it's fitted to its live container and carries its fitted { cols, rows }; the
 * server resizes the PTY + mirror to those dims BEFORE serializing, so the
 * snapshot is produced at exactly the width the client renders it at and
 * nothing reflows between serialize and display.
 *
 * This spec reproduces the mismatch deterministically through the REAL browser
 * client + REAL server (no mocks): it draws an alt-screen (TUI) paragraph while
 * the terminal is fitted to a NARROW width, then tears the client down, widens
 * the viewport, and re-navigates so a FRESH WIDE client reconnects to the
 * still-narrow server mirror. A marker word authored just past the narrow wrap
 * boundary must stay on a LATER row after reconnect; a stale-width snapshot
 * re-wrapped at the wide client width would pull it onto row 0 — the scatter.
 *
 * Renderer note: `useWebGLTerminalRenderer: false` so xterm falls back to its
 * DOM renderer and `.xterm-rows` carries the real glyphs the assertion reads.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const TOKEN = "e2e-replay-width-sync-token";
const PROJECT = "alpha-replay-width";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const MARKER = "SCATTERZEBRA";

// Start narrow so the first session fits the terminal to a small column count;
// the test widens the viewport before the reconnect (see the body). Both are
// ≥1024px so `useIsDesktop()` stays true and the shared dockview (which hosts
// the terminal) renders in each session.
const NARROW = { width: 1024, height: 800 };
const WIDE = { width: 1800, height: 900 };

let server: ServerHandle;
let tmpHome: string;
let workdir: string;

function makeGitWorkdir(prefix: string, home: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = makeGitWorkdir("band-replay-width-", tmpHome);
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
  // DOM renderer (not WebGL) so printed glyphs land in `.xterm-rows` for
  // `readTerminalRenderedRows`.
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal reconnect replay width-sync", () => {
  test("a fresh wide client reconnecting to a narrow mirror renders without reflow scatter", async ({
    page,
  }) => {
    // Terminal-heavy: two full workspace mounts + rendered-text polls.
    test.setTimeout(90_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // --- Session 1: fit to a NARROW width and draw an alt-screen paragraph ---
    await workspacePage.setViewport(NARROW.width, NARROW.height);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE);

    // Calibrate against the ACTUAL fitted width so the marker sits just past
    // the narrow wrap boundary regardless of platform font metrics.
    const narrowCols = await workspacePage.terminalCols(WORKSPACE);
    expect(narrowCols).toBeGreaterThan(0);

    // Author a paragraph whose unique MARKER starts a few columns PAST the
    // narrow wrap — so it belongs on row 1+ at the narrow width, but would land
    // on row 0 if the snapshot were re-wrapped at the wide client width.
    const filler = "A".repeat(narrowCols + 6);
    const paragraph = `${filler}${MARKER}${"B".repeat(30)}`;
    // Stage the draw in a script so the escape bytes never go through
    // `keyboard.type` (fragile) — only the short `bash <path>` line is typed.
    // Enter the alt screen and home the cursor so the paragraph starts at row 0.
    const drawScript = join(workdir, "draw.sh");
    writeFileSync(drawScript, `printf '\\033[?1049h\\033[H${paragraph}'\n`, "utf-8");

    // Self-verifying type: retries if the marker doesn't render (keystrokes
    // typed into xterm's hidden textarea can be dropped wholesale under
    // parallel CI load). The draw is idempotent (redraws the alt-screen
    // paragraph), so a retype is safe. This both runs the draw AND waits for
    // the marker to render (proving the DOM renderer is active) before we tear
    // the client down.
    await workspacePage.runInTerminalUntilRendered(
      WORKSPACE,
      `bash ${drawScript}`,
      new RegExp(MARKER),
    );

    // --- Drop the client WITHOUT resizing the mirror, then widen ---
    // Navigating away tears down the xterm + socket; the server keeps the PTY
    // (and its narrow mirror). Widening the viewport now affects only the FRESH
    // client mounted next.
    await workspacePage.navigateToBlank();
    await workspacePage.setViewport(WIDE.width, WIDE.height);

    // --- Session 2: a fresh WIDE client reconnects and replays ---
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);

    // The wide client is genuinely wider than the mirror was — otherwise the
    // test proves nothing.
    await expect
      .poll(() => workspacePage.terminalCols(WORKSPACE), { timeout: 20_000 })
      .toBeGreaterThan(narrowCols + MARKER.length);

    // Positive anchor: the replayed paragraph really did render.
    await expect
      .poll(async () => (await workspacePage.readTerminalRenderedRows(WORKSPACE)).join("\n"), {
        timeout: 20_000,
      })
      .toContain(MARKER);

    // The scatter assertion: with the snapshot serialized at the client's
    // width, the narrow wrap is preserved, so the marker stays off row 0 (row 0
    // is just early filler). A stale-width snapshot re-wrapped at the wide
    // client width would carry the marker onto row 0.
    const rows = await workspacePage.readTerminalRenderedRows(WORKSPACE);
    expect(rows[0]).not.toContain(MARKER);
    expect(rows[0]).toContain("A");
  });
});
