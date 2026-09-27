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

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { TerminalTouchSurface } from "./pages/TerminalTouchSurface";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-touch-scroll-token";
// One project per test: the probe keeps the first terminal in raw mode.
const MOUSE_PROJECT = "alpha-touch-mouse";
const SHELL_PROJECT = "alpha-touch-shell";
const MOUSE_WORKSPACE = toWorkspaceId(MOUSE_PROJECT, "main");
const SHELL_WORKSPACE = toWorkspaceId(SHELL_PROJECT, "main");
// `readInputLog` shows ESC as `^[`, so a failure prints readable input.
const SGR_WHEEL_REPORT = /\^\[\[<(64|65);(\d+);(\d+)M/g;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

let server: ServerHandle;
let tmpHome: string;
let mouseWorkdir: string;
let shellWorkdir: string;

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

/** The probe's input log with ESC written as `^[`, or "" before the first
 *  byte arrives. */
function readInputLog(path: string): string {
  try {
    return readFileSync(path, "latin1").replaceAll("\x1b", "^[");
  } catch {
    return "";
  }
}

/** Poll until the log has grown past `baseline` characters and is unchanged
 *  between two reads 500 ms apart, i.e. the latest swipe and its momentum
 *  have finished sending. */
async function waitForInputToSettle(path: string, baseline = 0): Promise<string> {
  let previous: string | null = null;
  await expect
    .poll(
      () => {
        const current = readInputLog(path);
        const settled = current.length > baseline && current === previous;
        previous = current;
        return settled;
      },
      { intervals: [500], timeout: 20_000 },
    )
    .toBe(true);
  return readInputLog(path);
}

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

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

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
    const probe = join(mouseWorkdir, "mouse-probe.mjs");
    const inputLog = join(mouseWorkdir, "mouse-probe-input.log");
    writeFileSync(
      probe,
      [
        'import { appendFileSync } from "node:fs";',
        "process.stdin.setRawMode(true);",
        'process.stdout.write("\\x1b[?1000h\\x1b[?1006h");',
        'process.stdout.write("MOUSE_" + "PROBE_READY\\r\\n");',
        `process.stdin.on("data", (chunk) => appendFileSync(${JSON.stringify(inputLog)}, chunk));`,
      ].join("\n"),
      "utf-8",
    );

    await workspacePage.goto(MOUSE_WORKSPACE);
    await workspacePage.waitForMobileReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.waitForTerminalRenderedPrompt(MOUSE_WORKSPACE);
    await workspacePage.runInTerminalUntilRendered(
      MOUSE_WORKSPACE,
      `${process.execPath} ${probe}`,
      /MOUSE_PROBE_READY/,
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
