/**
 * Desktop wheel scrolling over mouse-tracking programs, and input coalescing.
 *
 * Wheel (`src/lib/terminal-mouse-wheel.ts`): when a program turns on wheel
 * mouse tracking (Claude Code does), Band builds the wheel reports itself
 * instead of xterm, which scales trackpad deltas by 0.3. A probe program turns
 * tracking on and appends every byte it reads to a file:
 *
 *  1. Trackpad-sized pixel deltas send one SGR report per row of travel, the
 *     fraction carried between events, at the cell under the pointer. Shift
 *     leaves the wheel to xterm, which sends nothing.
 *  2. Mouse wheel notches send between 1 and 9 reports each. SGR pixel mode
 *     reports the pointer's pixel, and X10 bytes carry the cell and the Ctrl
 *     modifier bit.
 *  3. On the alternate screen without mouse tracking, the wheel still sends
 *     arrow keys; in a shell it still scrolls the scrollback.
 *
 * Input (`src/lib/terminal-input-queue.ts`): keys that queue up while the page
 * is busy go out in fewer WebSocket messages than keys, with the program
 * reading the same bytes in the same order. A lone keystroke still goes out
 * as its own message, and the typing-latency probe still stamps every key
 * typed at a normal pace. (The probe pairs each keystroke with one output
 * frame, so it can't measure a burst whose echo comes back in one frame.)
 *
 * Renderer note: `useWebGLTerminalRenderer: false` so
 * `runInTerminalUntilRendered` can read the probes' ready markers from the DOM
 * renderer's rows.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
  readInputLog,
  waitForInputToSettle,
  writeInputProbe,
} from "./helpers/terminal-input-probe";
import { TerminalInputSurface } from "./pages/TerminalInputSurface";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-wheel-input-token";
// One project per test: each probe keeps its terminal in raw mode.
const PROJECTS = {
  trackpad: "wheel-trackpad",
  notches: "wheel-notches",
  pixels: "wheel-sgr-pixels",
  x10: "wheel-x10",
  altScreen: "wheel-alt-screen",
  shell: "wheel-shell",
  burst: "input-burst",
  latency: "input-latency",
} as const;
type ProbeName = keyof typeof PROJECTS;
// The input log shows ESC as `^[`, so a failure prints readable input.
const SGR_WHEEL_REPORT = /\^\[\[<(\d+);(\d+);(\d+)M/g;

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
const workdirs = {} as Record<ProbeName, string>;

function wheelReports(log: string): { code: number; col: number; row: number }[] {
  return [...log.matchAll(SGR_WHEEL_REPORT)].map(([, code, col, row]) => ({
    code: Number(code),
    col: Number(col),
    row: Number(row),
  }));
}

/**
 * Start a probe in the workspace's terminal: it writes `setup` to the
 * terminal, prints a ready marker, and appends raw stdin to a log. Returns
 * the log's path.
 */
async function startProbe(
  workspacePage: WorkspacePage,
  name: ProbeName,
  setup: string,
): Promise<string> {
  const workspaceId = toWorkspaceId(PROJECTS[name], "main");
  const probe = writeInputProbe(workdirs[name], setup);
  await workspacePage.goto(workspaceId);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await workspacePage.waitForTerminalReady(20_000);
  await workspacePage.waitForTerminalRenderedPrompt(workspaceId);
  await workspacePage.runInTerminalUntilRendered(workspaceId, probe.command, INPUT_PROBE_READY);
  return probe.logPath;
}

function openSurface(page: Page, name: ProbeName) {
  return {
    workspacePage: new WorkspacePage(page, server.url, TOKEN),
    terminal: new TerminalInputSurface(page, toWorkspaceId(PROJECTS[name], "main")),
  };
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // Keep zsh from running its new-user wizard in the temp home.
  writeFileSync(join(tmpHome, ".zshrc"), "PROMPT='$ '\n");
  const projects = [];
  for (const [name, project] of Object.entries(PROJECTS) as [ProbeName, string][]) {
    workdirs[name] = makeGitWorkdir(`band-${project}-`, tmpHome);
    projects.push({
      name: project,
      path: workdirs[name],
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: workdirs[name] }],
    });
  }
  seedState(tmpHome, { projects });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  for (const dir of Object.values(workdirs)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test.describe("Terminal wheel over mouse-tracking programs", () => {
  test("trackpad deltas send one report per row at the pointer's cell", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage, terminal } = openSurface(page, "trackpad");
    // Wheel mouse tracking (DECSET 1000) with SGR encoding (1006).
    const inputLog = await startProbe(workspacePage, "trackpad", "\x1b[?1000h\x1b[?1006h");

    const { cellHeight } = await terminal.readGrid();
    // 3.5 rows of travel in small steps: exactly 3 reports. xterm's own
    // conversion scales trackpad deltas by 0.3 and would send one.
    await terminal.trackpadScroll(7, 3, cellHeight * 3.5);
    const down = await waitForInputToSettle(inputLog);
    expect(down.replace(SGR_WHEEL_REPORT, "")).toBe("");
    expect(wheelReports(down)).toEqual(Array(3).fill({ code: 65, col: 7, row: 3 }));

    // Reversing drops the carried half row: 1.75 rows up is one report.
    await terminal.trackpadScroll(12, 5, -cellHeight * 1.75);
    const up = (await waitForInputToSettle(inputLog, down.length)).slice(down.length);
    expect(wheelReports(up)).toEqual([{ code: 64, col: 12, row: 5 }]);

    // Shift leaves the wheel to xterm, which drops shift+wheel in this mode.
    await terminal.hoverCell(12, 5);
    await terminal.wheel(100, 3, { modifier: "Shift" });
    await terminal.press("z");
    const afterShift = (await waitForInputToSettle(inputLog, down.length + up.length)).slice(
      down.length + up.length,
    );
    expect(afterShift).toBe("z");
  });

  test("mouse wheel notches send 1 to 9 reports each", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage, terminal } = openSurface(page, "notches");
    const inputLog = await startProbe(workspacePage, "notches", "\x1b[?1000h\x1b[?1006h");

    await terminal.hoverCell(4, 2);
    const notches = 8;
    await terminal.wheel(100, notches);
    const received = await waitForInputToSettle(inputLog);
    expect(received.replace(SGR_WHEEL_REPORT, "")).toBe("");
    const reports = wheelReports(received);
    expect(reports.length).toBeGreaterThanOrEqual(notches);
    expect(reports.length).toBeLessThanOrEqual(notches * 9);
    for (const report of reports) {
      expect(report).toEqual({ code: 65, col: 4, row: 2 });
    }
  });

  test("SGR pixel mode reports the pointer's pixel inside the screen", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage, terminal } = openSurface(page, "pixels");
    // SGR pixel encoding (DECSET 1016).
    const inputLog = await startProbe(workspacePage, "pixels", "\x1b[?1000h\x1b[?1016h");

    const grid = await terminal.readGrid();
    await terminal.hoverCell(10, 4);
    await terminal.wheel(100);
    const received = await waitForInputToSettle(inputLog);
    expect(received.replace(SGR_WHEEL_REPORT, "")).toBe("");
    const reports = wheelReports(received);
    expect(reports.length).toBeGreaterThan(0);
    // `hoverCell` aims at the middle of the cell, so the pixel is half a cell
    // past the cell's corner, give or take rounding.
    const cellWidth = grid.width / grid.cols;
    for (const { code, col: x, row: y } of reports) {
      expect(code).toBe(65);
      expect(Math.abs(x - 9.5 * cellWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(y - 3.5 * grid.cellHeight)).toBeLessThanOrEqual(1);
    }
  });

  test("X10 encoding carries the cell and the Ctrl bit", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage, terminal } = openSurface(page, "x10");
    // Wheel tracking with no encoding mode: X10 bytes.
    const inputLog = await startProbe(workspacePage, "x10", "\x1b[?1000h");

    await terminal.hoverCell(4, 2);
    await terminal.wheel(100, 1, { modifier: "Control" });
    const received = await waitForInputToSettle(inputLog);
    // Button 65 + Ctrl 16 + 32 is "q"; column 4 and row 2, each + 32, are
    // "$" and '"'.
    expect(received).toMatch(/^(\^\[\[Mq\$")+$/);
  });

  test("the alternate screen without mouse tracking still gets arrow keys", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage, terminal } = openSurface(page, "altScreen");
    // Alternate screen (DECSET 1049), no mouse tracking.
    const inputLog = await startProbe(workspacePage, "altScreen", "\x1b[?1049h");

    await terminal.hoverCell(5, 5);
    await terminal.wheel(100, 3);
    const down = await waitForInputToSettle(inputLog);
    expect(down).toMatch(/^(\^\[\[B)+$/);
    await terminal.wheel(-100, 3);
    const up = (await waitForInputToSettle(inputLog, down.length)).slice(down.length);
    expect(up).toMatch(/^(\^\[\[A)+$/);
  });

  test("the wheel scrolls a shell's scrollback", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage, terminal } = openSurface(page, "shell");
    const workspaceId = toWorkspaceId(PROJECTS.shell, "main");
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.waitForTerminalRenderedPrompt(workspaceId);
    await workspacePage.runInTerminalUntilRendered(
      workspaceId,
      'for i in $(seq 1 300); do echo "scroll-line-$i"; done; echo SCROLL_"DONE"',
      /SCROLL_DONE/,
    );
    await expect
      .poll(async () => (await terminal.readScrollPosition())?.baseY ?? 0)
      .toBeGreaterThan(100);
    const before = await terminal.readScrollPosition();
    if (!before) throw new Error("terminal not loaded");

    await terminal.hoverCell(5, 5);
    await terminal.wheel(-100, 3);
    await expect
      .poll(async () => (await terminal.readScrollPosition())?.viewportY ?? before.viewportY)
      .toBeLessThan(before.viewportY - 5);
  });
});

test.describe("Terminal input coalescing", () => {
  test("keys queued behind a busy page share messages; a lone key is its own", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage, terminal } = openSurface(page, "burst");
    const inputMessages = terminal.trackInputMessages();
    const inputLog = await startProbe(workspacePage, "burst", "");

    // A lone keystroke is one message of its own. (That it goes out without
    // waiting a turn isn't observable at the WebSocket; the latency test below
    // bounds it.)
    const sentBefore = inputMessages().length;
    await terminal.press("q");
    await expect.poll(() => readInputLog(inputLog)).toBe("q");
    expect(inputMessages().slice(sentBefore)).toEqual(["q"]);

    const burst = "abcdefghijklmnopqrst";
    const sentBeforeBurst = inputMessages().length;
    await terminal.typeWhileBusy(burst);
    await expect.poll(() => readInputLog(inputLog)).toBe(`q${burst}`);
    const burstMessages = inputMessages().slice(sentBeforeBurst);
    expect(burstMessages.join("")).toBe(burst);
    expect(burstMessages.length).toBeLessThan(burst.length / 2);
  });

  test("the typing-latency probe still stamps every echoed key", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspacePage } = openSurface(page, "latency");
    const workspaceId = toWorkspaceId(PROJECTS.latency, "main");
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.focusPane(0);
    await workspacePage.waitForTypingEcho();

    await workspacePage.startTypingLatencyProbe();
    await workspacePage.typeKeysPaced(20, 60);
    const report = await workspacePage.stopTypingLatencyProbe();
    expect(report.samples).toBe(20);
    expect(report.unmatched).toBe(0);
    // No multi-frame stall between keydown and the socket. A coalescing turn
    // is well under a millisecond, so this can't tell one from none.
    expect(report.inputToDispatchMs.p90).toBeLessThan(50);
  });
});
