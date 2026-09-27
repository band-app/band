/**
 * Finger scrolling in a terminal on a phone.
 *
 * Bug: swiping over a terminal running Claude Code typed text like
 * `NaN;NaNM` into its prompt. xterm 6.1's gesture helper keeps dispatching
 * inertia events after the finger lifts, and those carry no coordinates. With
 * the program's wheel mouse tracking on, xterm turned each one into a wheel
 * report with NaN coordinates, which the program read as keyboard input. Band's
 * own touch handler scrolled xterm's buffer as well, so one swipe was handled
 * twice.
 *
 * Fix (`src/lib/terminal-touch-scroll.ts`): Band's touch layer keeps every
 * touchmove away from xterm's gesture helper and runs its own momentum, which
 * sends wheel reports built from the finger's real position.
 *
 *  1. A probe program turns on SGR wheel mouse tracking (DECSET 1000 + 1006),
 *     the way Claude Code does, and appends every byte it reads to a file. A
 *     swipe up and a swipe down must deliver only well-formed wheel reports
 *     inside the terminal's grid: wheel down for the finger moving up, wheel up
 *     for the finger moving down.
 *  2. In a plain shell with scrollback, a swipe down scrolls the viewport up
 *     through the output, a tap still focuses the terminal, and a long press
 *     still selects a word.
 *
 * Renderer note: `useWebGLTerminalRenderer: false` so
 * `runInTerminalUntilRendered` can read the probe's ready marker from the DOM
 * renderer's rows.
 */

import { rmSync } from "node:fs";
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
import {
  INPUT_PROBE_READY,
  makeGitWorkdir,
  waitForInputToSettle,
  writeInputProbe,
} from "./helpers/terminal-input-probe";
import { TerminalTouchSurface } from "./pages/TerminalTouchSurface";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-touch-scroll-token";
// One project per test: the probe keeps the first terminal in raw mode.
const MOUSE_PROJECT = "alpha-touch-mouse";
const SHELL_PROJECT = "alpha-touch-shell";
const MOUSE_WORKSPACE = toWorkspaceId(MOUSE_PROJECT, "main");
const SHELL_WORKSPACE = toWorkspaceId(SHELL_PROJECT, "main");
// The input log shows ESC as `^[`, so a failure prints readable input.
const SGR_WHEEL_REPORT = /\^\[\[<(64|65);(\d+);(\d+)M/g;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

let server: ServerHandle;
let tmpHome: string;
let mouseWorkdir: string;
let shellWorkdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  mouseWorkdir = makeGitWorkdir("band-touch-mouse-", tmpHome);
  shellWorkdir = makeGitWorkdir("band-touch-shell-", tmpHome);
  seedState(tmpHome, {
    projects: [
      {
        name: MOUSE_PROJECT,
        path: mouseWorkdir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: mouseWorkdir }],
      },
      {
        name: SHELL_PROJECT,
        path: shellWorkdir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: shellWorkdir }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  for (const dir of [mouseWorkdir, shellWorkdir]) {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test.describe("Terminal touch scrolling", () => {
  test("a swipe over a mouse-tracking program sends only valid wheel reports", async ({ page }) => {
    test.setTimeout(90_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const terminal = new TerminalTouchSurface(page, MOUSE_WORKSPACE);

    // Turns on wheel mouse tracking with SGR encoding and logs raw stdin.
    const probe = writeInputProbe(mouseWorkdir, "\x1b[?1000h\x1b[?1006h");
    const inputLog = probe.logPath;

    await workspacePage.goto(MOUSE_WORKSPACE);
    await workspacePage.waitForMobileReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.waitForTerminalRenderedPrompt(MOUSE_WORKSPACE);
    await workspacePage.runInTerminalUntilRendered(
      MOUSE_WORKSPACE,
      probe.command,
      INPUT_PROBE_READY,
    );

    await terminal.swipe(300);
    const afterSwipeUp = await waitForInputToSettle(inputLog);
    await terminal.swipe(-300);
    const received = await waitForInputToSettle(inputLog, afterSwipeUp.length);

    const size = await terminal.readSize();
    if (!size) throw new Error("terminal not loaded");
    const reports = [...received.matchAll(SGR_WHEEL_REPORT)];
    // Nothing but wheel reports reached the program: no NaN, no stray text.
    expect(received.replace(SGR_WHEEL_REPORT, "")).toBe("");
    for (const [, , col, row] of reports) {
      expect(Number(col)).toBeGreaterThanOrEqual(1);
      expect(Number(col)).toBeLessThanOrEqual(size.cols);
      expect(Number(row)).toBeGreaterThanOrEqual(1);
      expect(Number(row)).toBeLessThanOrEqual(size.rows);
    }
    // The finger moving up scrolled down (65), then moving down scrolled up (64).
    const buttons = (log: string) => [...log.matchAll(SGR_WHEEL_REPORT)].map((m) => m[1]);
    expect(new Set(buttons(afterSwipeUp))).toEqual(new Set(["65"]));
    expect(new Set(buttons(received.slice(afterSwipeUp.length)))).toEqual(new Set(["64"]));
  });

  test("a swipe down scrolls a shell's scrollback; tap and long press still work", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const terminal = new TerminalTouchSurface(page, SHELL_WORKSPACE);

    await workspacePage.goto(SHELL_WORKSPACE);
    await workspacePage.waitForMobileReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.waitForTerminalRenderedPrompt(SHELL_WORKSPACE);
    await workspacePage.runInTerminalUntilRendered(
      SHELL_WORKSPACE,
      'for i in $(seq 1 300); do echo "scroll-line-$i"; done; echo SCROLL_"DONE"',
      /SCROLL_DONE/,
    );

    await expect
      .poll(async () => (await terminal.readScrollPosition())?.baseY ?? 0)
      .toBeGreaterThan(100);
    const before = await terminal.readScrollPosition();
    if (!before) throw new Error("terminal not loaded");
    expect(before.viewportY).toBe(before.baseY);

    await terminal.unfocus();
    await expect(terminal.input).not.toBeFocused();
    await terminal.swipe(-300);

    await expect
      .poll(async () => (await terminal.readScrollPosition())?.viewportY ?? before.viewportY)
      .toBeLessThan(before.viewportY - 5);

    // The swipe itself must not have focused the terminal, or the tap below
    // would prove nothing.
    await expect(terminal.input).not.toBeFocused();
    await terminal.tap();
    await expect(terminal.input).toBeFocused();

    // A finger held still still selects the word under it.
    expect(await terminal.hasSelection()).toBe(false);
    await terminal.longPress(() => expect.poll(() => terminal.hasSelection()).toBe(true));
  });
});
