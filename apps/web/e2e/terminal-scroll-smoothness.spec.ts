/**
 * Scroll-smoothness benchmark (not a pass/fail test; skipped unless
 * `BAND_SCROLL_BENCH=1`). Scrolls a fullscreen TUI the way Claude Code's
 * fullscreen mode behaves: alternate screen, SGR wheel reports, and a full
 * repaint wrapped in a DEC 2026 synchronized-output frame for every batch of
 * wheel reports it reads. Measures, in the page (`pages/TerminalScrollProbe.ts`):
 *
 *   wheel -> send -> arrival -> parsed -> paint latency per wheel event,
 *   the gaps between renders that moved the scroll position,
 *   dropped browser frames, and long animation frames by invoker.
 *
 *   BAND_SCROLL_BENCH=1 pnpm --filter @band-app/web test:e2e \
 *     terminal-scroll-smoothness --headed --reporter=list
 *
 * Run headed so the WebGL renderer uses the real GPU. `BENCH_RENDERER=dom`
 * uses the DOM renderer, `BENCH_PROFILE=1` adds a main-thread CPU profile.
 * The "Claude Code" group scrolls a real resumed session instead (see its
 * comment); the synthetic TUI can't reproduce Claude's frame timing, and the
 * choppiness it measured only showed up with the real thing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { type ScrollReport, TerminalScrollProbe } from "./pages/TerminalScrollProbe";
import { TerminalSurface } from "./pages/TerminalSurface";
import { WorkspacePage } from "./pages/WorkspacePage";

test.skip(process.env.BAND_SCROLL_BENCH !== "1", "benchmark; set BAND_SCROLL_BENCH=1");

const TOKEN = "e2e-scroll-bench-token";
const PROJECT = "scroll-bench";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 4_000);

/**
 * A fullscreen TUI: one row per wheel report, top row `OFF=<n>`, every row
 * styled like an agent transcript (several SGR runs per row). Redraws the
 * whole screen in one synchronized frame after each read that moved it.
 */
const TUI = String.raw`
use strict; use warnings;
$| = 1;
system("stty raw -echo");
my ($rows, $cols) = split ' ', qx(stty size);
print "\e[?1049h\e[?1000h\e[?1006h\e[?25l";
my $off = 0;
my $heavy = ($ARGV[0] // "") eq "heavy";
sub run {
  my ($n, $w, $text) = @_;
  return "\e[3" . (($n + $w) % 7 + 1) . "m$text\e[0m" unless $heavy;
  my ($r, $g, $b) = (($n * 37 + $w * 11) % 256, ($n * 13 + $w * 71) % 256, ($w * 29) % 256);
  return "\e[38;2;$r;$g;$b" . "m\e[48;2;20;20;30m$text\e[0m";
}
sub draw {
  my $f = "\e[?2026h\e[H\e[7mOFF=$off\e[0m\e[K\r\n";
  for my $r (1 .. $rows - 1) {
    my $n = $off + $r;
    my $line = "";
    my $w = 0;
    while (length($line) < ($cols - 16) * 2) {
      $line .= run($n, $w, sprintf("w%06d-%02d ", $n, $w));
      $w++;
      last if $w * 11 >= $cols - 11;
    }
    $f .= $line . "\e[K" . ($r < $rows - 1 ? "\r\n" : "");
  }
  print $f . "\e[?2026l";
}
draw();
my $buf = "";
while (1) {
  my $n = sysread(STDIN, my $chunk, 65536);
  last unless $n;
  $buf .= $chunk;
  last if $buf =~ /q/;
  my $moved = 0;
  while ($buf =~ s/\e\[<(\d+);\d+;\d+[Mm]//) {
    if ($1 == 65) { $off++; $moved = 1 }
    elsif ($1 == 64 && $off > 0) { $off--; $moved = 1 }
  }
  draw() if $moved;
}
print "\e[?1006l\e[?1000l\e[?25h\e[?1049l";
system("stty sane");
`;

test.use({ viewport: { width: 1440, height: 900 } });

let server!: ServerHandle;
let tmpHome!: string;
let tuiPath!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  writeFileSync(join(tmpHome, ".zshrc"), "PROMPT='$ '\n");
  tuiPath = join(tmpHome, "scroll-tui.pl");
  writeFileSync(tuiPath, TUI);
  const repoPath = join(tmpHome, PROJECT);
  gitInHome(tmpHome, ["init", "-q", "-b", "main", repoPath], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"], tmpHome);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    useWebGLTerminalRenderer: process.env.BENCH_RENDERER !== "dom",
  });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

function print(
  label: string,
  r: ScrollReport,
  profile?: { idlePct: number; top: { fn: string; ms: number }[] },
) {
  const row = (
    name: string,
    s: { n: number; p50: number; p90: number; p99: number; max: number },
  ) =>
    `  ${name.padEnd(16)} n=${String(s.n).padEnd(4)} p50=${s.p50}  p90=${s.p90}  p99=${s.p99}  max=${s.max}`;
  console.log(
    [
      `[scroll] ${label}: wheel events=${r.wheelEvents} reports=${r.reports} painted=${r.painted}`,
      row("wheelToSend", r.wheelToSend),
      row("sendToArrival", r.sendToArrival),
      row("arrivalToParsed", r.arrivalToParsed),
      row("parsedToPaint", r.parsedToPaint),
      row("wheelToPaint", r.wheelToPaint),
      row("paintGaps", r.paintGaps),
      `  position paints=${r.positionPaints} gaps>33ms=${r.gapsOver33} >50ms=${r.gapsOver50} >100ms=${r.gapsOver100}`,
      `  gaps>40ms at: ${r.bigGaps.map((g) => `${g.at}(+${g.gap})`).join(" ")}`,
      `  screen changes=${r.screenChanges} gaps>33ms=${r.changeGapsOver33} >50ms=${r.changeGapsOver50}`,
      row("changeGaps", r.changeGaps),
      row("sendToChange", r.sendToChange),
      `  output ${r.outputTotalBytes} bytes, ${r.bytesPerSend} per send, sync frames=${r.syncFrames}`,
      row("rafGaps", r.rafGaps),
      "  timeline (ms: sends/KB/syncs/changes):",
      ...r.timeline.map(
        (b) => `    ${String(b.t).padStart(5)}: ${b.sends}/${b.kb}/${b.syncs}/${b.changes}`,
      ),
      `  raf gaps>25ms=${r.rafOver25}`,
      `  output frames=${r.outputFrames} per position paint=${r.framesPerPaint}`,
      row("outputBytes", r.outputBytes),
      `  long frames=${r.longFrames} total=${r.longFrameMs}ms`,
      ...Object.entries(r.byInvoker)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([invoker, ms]) => `    ${ms}ms  ${invoker}`),
      ...(profile
        ? [
            `  main thread idle ${profile.idlePct}%, top self time:`,
            ...profile.top.slice(0, 15).map(({ fn, ms }) => `    ${ms}ms  ${fn}`),
          ]
        : []),
    ].join("\n"),
  );
}

const SCENARIOS: { name: string; deltaY: number; intervalMs: number; frame: string }[] = [
  // A trackpad swipe: small pixel deltas at display rate.
  { name: "trackpad", deltaY: 24, intervalMs: 16, frame: "light" },
  // A fast-spun mouse wheel: whole notches, 20 ms apart.
  { name: "wheel", deltaY: 100, intervalMs: 20, frame: "light" },
  // Truecolor runs on every word, like an agent transcript: ~3x the bytes.
  { name: "trackpad-heavy", deltaY: 24, intervalMs: 16, frame: "heavy" },
];

test.describe("Terminal scroll smoothness (benchmark)", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async ({ page }) => {
      test.setTimeout(120_000);
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);
      const probe = new TerminalScrollProbe(page, WORKSPACE);
      await probe.install();
      await workspacePage.goto(WORKSPACE);
      await workspacePage.waitForReady();
      await workspacePage.openTerminalTab();
      await workspacePage.waitForTerminalReady(20_000);
      await workspacePage.focusPane(0);
      await workspacePage.waitForTypingEcho();
      await workspacePage.typeInPane(0, `clear; perl ${tuiPath} ${scenario.frame}`);
      await expect.poll(() => probe.readTopOffset(), { timeout: 10_000 }).toBe(0);

      const grid = await new TerminalSurface(page, WORKSPACE).readGrid();
      const stopProfile =
        process.env.BENCH_PROFILE === "1" ? await workspacePage.profileMainThread() : null;
      await probe.start();
      await workspacePage.wheelPaced(
        grid.left + grid.width / 2,
        grid.top + grid.height / 2,
        scenario.deltaY,
        scenario.intervalMs,
        DURATION_MS,
      );
      // Let the last reports reach the screen.
      const reportsSent = await probe.readReportsSent();
      await expect.poll(() => probe.readTopOffset(), { timeout: 10_000 }).toBe(reportsSent);
      const report = await probe.stop(0);
      await workspacePage.pressKeyInPane(0, "q");
      const profile = await stopProfile?.();
      print(scenario.name, report, profile ?? undefined);
      expect(report.painted).toBeGreaterThan(0);
    });
  }
});

/**
 * The real thing: resume a Claude Code session (forked, so the original
 * transcript is left alone) and wheel up through its transcript. Opt in with
 * `BENCH_CLAUDE_SESSION=<id> BENCH_CLAUDE_CWD=<project dir>`; the shell runs it
 * with your real HOME, so it uses your settings (set `"tui": "fullscreen"`)
 * and login. Panes set `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1`; `BENCH_CLAUDE_ENV`
 * adds env vars, e.g. `CLAUDE_CODE_FORCE_SYNC_OUTPUT=` to measure Claude's
 * full-screen repaints without scroll regions. Nothing is sent to the model.
 */
test.describe("Claude Code scroll smoothness (benchmark)", () => {
  const session = process.env.BENCH_CLAUDE_SESSION;
  const cwd = process.env.BENCH_CLAUDE_CWD;
  test.skip(!session || !cwd, "set BENCH_CLAUDE_SESSION and BENCH_CLAUDE_CWD");

  test("claude trackpad", async ({ page }) => {
    test.setTimeout(180_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const probe = new TerminalScrollProbe(page, WORKSPACE);
    await probe.install();
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.focusPane(0);
    await workspacePage.waitForTypingEcho();
    const debugFile = join(tmpHome, "claude-debug.txt");
    await workspacePage.typeInPane(
      0,
      `clear; cd '${cwd}' && HOME='${process.env.HOME}' ${process.env.BENCH_CLAUDE_ENV ?? ""} ` +
        `claude --resume ${session} --fork-session --debug-file '${debugFile}'`,
    );
    // Wait for Claude to turn on mouse tracking, then to finish drawing.
    await expect
      .poll(async () => JSON.parse(await probe.readModes()).modes.mouseTrackingMode, {
        timeout: 60_000,
      })
      .not.toBe("none");
    let last = await probe.readScreenHash();
    await expect
      .poll(
        async () => {
          const next = await probe.readScreenHash();
          const stable = next === last && next !== 0;
          last = next;
          return stable;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(true);

    const grid = await new TerminalSurface(page, WORKSPACE).readGrid();
    const stopProfile =
      process.env.BENCH_PROFILE === "1" ? await workspacePage.profileMainThread() : null;
    await probe.start();
    await workspacePage.wheelPaced(
      grid.left + grid.width / 2,
      grid.top + grid.height / 2,
      -24,
      16,
      DURATION_MS,
    );
    let settled = await probe.readScreenHash();
    await expect
      .poll(
        async () => {
          const next = await probe.readScreenHash();
          const stable = next === settled;
          settled = next;
          return stable;
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe(true);
    const report = await probe.stop(0);
    const profile = await stopProfile?.();
    print(
      `claude ${process.env.BENCH_CLAUDE_ENV ?? "(CLAUDE_CODE_FORCE_SYNC_OUTPUT=1)"}`,
      report,
      profile ?? undefined,
    );
    const debug = readFileSync(debugFile, "utf8")
      .split("\n")
      .filter((l) => /Terminal capabilities|DECSTBM/.test(l))
      .slice(-2);
    console.log(debug.map((l) => `  ${l.slice(0, 400)}`).join("\n"));
    await workspacePage.pressKeyInPane(0, "Control+c");
    await workspacePage.pressKeyInPane(0, "Control+c");
    expect(report.screenChanges).toBeGreaterThan(0);
  });
});
