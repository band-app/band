/**
 * Terminal fits its pane under app zoom.
 *
 * Bug: after changing the app zoom (Cmd/Ctrl +/-), a terminal's bottom rows
 * (Claude Code's prompt and status line) were cut off at the bottom of the
 * window. Zooming out left the terminal short of the pane instead.
 *
 * Root cause: terminal leaves use dockview's `renderer: "always"`, which
 * renders the panel in a `.dv-render-overlay` positioned by writing
 * getBoundingClientRect() values (zoomed, visual px) into inline
 * left/top/width/height. The CSS `zoom` the app sets on `<html>` then scaled
 * those values a second time, so at 110% the overlay came out 10% too tall
 * and ran past the window. Fix: a global rule in `globals.css` counter-zooms
 * the overlay and zooms its content back to the app zoom.
 *
 * The test draws a TUI-style screen whose last row carries a marker (redrawn
 * on SIGWINCH, like a real TUI), then zooms in and out through the real
 * keyboard shortcut. At every zoom level the terminal leaf's bottom edge must
 * stay where it was at 100% (the pane's bottom), and the marker row must stay
 * inside both the leaf and the window.
 *
 * Renderer note: `useWebGLTerminalRenderer: false` so xterm uses its DOM
 * renderer and each row is an element whose geometry the test can read.
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

const TOKEN = "e2e-terminal-app-zoom-fit-token";
const PROJECT = "alpha-app-zoom-fit";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const MARKER = "ZOOMFIT-LAST-ROW";
// Sub-pixel rounding of the overlay's inline sizes, in visual px.
const TOLERANCE_PX = 2;

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

test.use({ viewport: { width: 1400, height: 900 } });

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = makeGitWorkdir("band-app-zoom-fit-", tmpHome);
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

test.describe("Terminal under app zoom", () => {
  test("the terminal's last row stays inside its pane after zooming in and out", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE);

    // A minimal TUI: alt screen, marker on the last row, redrawn on resize.
    // Staged in a file so only the short `bash <path>` line is typed.
    const tuiScript = join(workdir, "tui.sh");
    writeFileSync(
      tuiScript,
      [
        `draw() { L=$(tput lines); printf '\\033[2J\\033[%d;1H%s' "$L" "${MARKER}"; }`,
        "trap draw WINCH",
        "printf '\\033[?1049h'",
        "draw",
        "while :; do sleep 0.05; done",
        "",
      ].join("\n"),
      "utf-8",
    );
    await workspacePage.runInTerminalUntilRendered(
      WORKSPACE,
      `bash ${tuiScript}`,
      new RegExp(MARKER),
    );

    const baseline = await workspacePage.readTerminalGeometry(WORKSPACE, MARKER);
    expect(baseline.markerRow).not.toBeNull();

    const expectFitted = async (zoom: number) => {
      // Positive anchor: the shortcut really moved the app to this zoom level.
      await expect.poll(() => workspacePage.readAppZoom()).toBeCloseTo(zoom, 2);
      await expect
        .poll(
          async () => {
            const g = await workspacePage.readTerminalGeometry(WORKSPACE, MARKER);
            const row = g.markerRow;
            return {
              leafBottomUnchanged: Math.abs(g.leafBottom - baseline.leafBottom) <= TOLERANCE_PX,
              // Inside the leaf, and on its last row rather than short of it.
              markerRowFillsLeaf:
                row !== null &&
                row.bottom <= g.leafBottom + TOLERANCE_PX &&
                g.leafBottom - row.bottom < row.height + TOLERANCE_PX,
              markerRowInsideWindow: row !== null && row.bottom <= g.viewportHeight,
            };
          },
          { message: `terminal geometry at ${Math.round(zoom * 100)}% zoom`, timeout: 15_000 },
        )
        .toEqual({
          leafBottomUnchanged: true,
          markerRowFillsLeaf: true,
          markerRowInsideWindow: true,
        });
    };

    // 100% → 110% → 120%: the overlay used to grow past the window.
    await workspacePage.zoomInViaShortcut();
    await expectFitted(1.1);
    await workspacePage.zoomInViaShortcut();
    await expectFitted(1.2);

    // 120% → 80%: the overlay used to stop short of the pane's bottom.
    for (let i = 0; i < 4; i++) await workspacePage.zoomOutViaShortcut();
    await expectFitted(0.8);
  });
});
