/**
 * Typing-latency benchmark (not a pass/fail test; skipped unless
 * `BAND_TYPING_BENCH=1`). Measures keystroke-to-paint latency in a terminal
 * through the in-app probe (`window.__bandTypingLatency`, see
 * `src/lib/terminal-typing-latency.ts`) while other terminals stream output:
 *
 *   idle    nothing else running
 *   split   a visible split pane next to the typing pane streams output
 *   parked  terminals in three other (parked) workspaces stream output
 *
 *   BAND_TYPING_BENCH=1 pnpm --filter @band-app/server test:e2e \
 *     terminal-typing-latency --headed --reporter=list
 *
 * Run headed so the WebGL renderer uses the real GPU; headless Chromium
 * falls back to software GL. `BENCH_FLOOD=saturate` swaps the default
 * 60 fps TUI-style redraw (~400 KB/s per terminal) for unbounded output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
import { WorkspacePage } from "./pages/WorkspacePage";

test.skip(process.env.BAND_TYPING_BENCH !== "1", "benchmark; set BAND_TYPING_BENCH=1");

const TOKEN = "e2e-typing-latency-token";
const PROJECT = "typing-bench";
const BRANCHES = ["idle", "split", "parked", "flood-1", "flood-2", "flood-3"];
const WS = Object.fromEntries(BRANCHES.map((b) => [b, toWorkspaceId(PROJECT, b)]));
const KEYS = Number(process.env.BENCH_KEYS ?? 150);
const KEY_INTERVAL_MS = 40;

const FLOODS: Record<string, string> = {
  tui: `perl -e '$|=1; my $i=0; while(1){ my $f="\\e[H"; for my $r (1..40){ $f .= "\\e[3" . (($r+$i)%7+1) . "m" . ("=" x 150) . "\\e[0m\\e[K\\n" } print $f; $i++; select(undef,undef,undef,0.016) }'`,
  saturate: `perl -e '$|=1; my $l = "\\e[32m" . ("x" x 150) . "\\e[0m\\n"; print $l while 1'`,
};
const FLOOD = FLOODS[process.env.BENCH_FLOOD ?? "tui"];

test.use({ viewport: { width: 1440, height: 900 } });

let server!: ServerHandle;
let tmpHome!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // Keep zsh from running its new-user wizard in the temp home.
  writeFileSync(join(tmpHome, ".zshrc"), "PROMPT='$ '\n");
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# typing bench\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  const worktrees = [{ branch: "main", path: repoPath }];
  for (const branch of BRANCHES) {
    const path = join(tmpHome, `${PROJECT}-${branch}`);
    gitInHome(repoPath, ["worktree", "add", "-q", "-b", branch, path], tmpHome);
    worktrees.push({ branch, path });
  }
  seedState(tmpHome, {
    projects: [{ name: PROJECT, path: repoPath, defaultBranch: "main", worktrees }],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

async function openTerminal(workspacePage: WorkspacePage, workspaceId: string): Promise<void> {
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(workspaceId, true)).toBeVisible({
    timeout: 20_000,
  });
  await workspacePage.waitForTerminalReady(20_000);
  await workspacePage.focusPane(0);
  await workspacePage.waitForTypingEcho();
}

async function measure(workspacePage: WorkspacePage, label: string): Promise<void> {
  await workspacePage.startFrameAttribution();
  const stopProfile =
    process.env.BENCH_PROFILE === "1" ? await workspacePage.profileMainThread() : null;
  await workspacePage.startTypingLatencyProbe();
  await workspacePage.typeKeysPaced(KEYS, KEY_INTERVAL_MS);
  const report = await workspacePage.stopTypingLatencyProbe();
  const frames = await workspacePage.stopFrameAttribution();
  const profile = await stopProfile?.();
  const row = (name: string, p: { p50: number; p90: number; p99: number; max: number }) =>
    `  ${name.padEnd(18)} p50=${p.p50}  p90=${p.p90}  p99=${p.p99}  max=${p.max}`;
  console.log(
    [
      `[typing-latency] ${label}: samples=${report.samples} unmatched=${report.unmatched}`,
      row("inputToDispatch", report.inputToDispatchMs),
      row("dispatchToArrival", report.dispatchToArrivalMs),
      row("arrivalToParsed", report.arrivalToParsedMs),
      row("parsedToPaint", report.parsedToPaintMs),
      row("inputToPaint", report.inputToPaintMs),
      `  long frames: ${frames.frames} total=${frames.totalMs}ms script=${frames.scriptMs}ms render=${frames.renderMs}ms`,
      ...Object.entries(frames.byInvoker)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([invoker, ms]) => `    ${ms}ms  ${invoker}`),
      ...(profile
        ? [
            `  main thread idle ${profile.idlePct}%, top self time:`,
            ...profile.top.map(({ fn, ms }) => `    ${ms}ms  ${fn}`),
          ]
        : []),
    ].join("\n"),
  );
  expect(report.samples).toBeGreaterThan(0);
}

test.describe("Terminal typing latency (benchmark)", () => {
  test("idle", async ({ page }) => {
    test.setTimeout(120_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WS.idle);
    await workspacePage.waitForReady();
    await openTerminal(workspacePage, WS.idle);
    await workspacePage.focusPane(0);
    await measure(workspacePage, "idle");
  });

  test("split: a visible neighbour pane streams output", async ({ page }) => {
    test.setTimeout(120_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WS.split);
    await workspacePage.waitForReady();
    await openTerminal(workspacePage, WS.split);
    await workspacePage.focusPane(0);
    await workspacePage.splitTerminalRight();
    await expect(workspacePage.terminalPanes()).toHaveCount(2);
    await workspacePage.focusPane(1);
    await workspacePage.waitForTypingEcho();
    await workspacePage.typeInPane(1, FLOOD);
    await workspacePage.focusPane(0);
    await measure(workspacePage, "split");
  });

  test("parked: three hidden workspaces stream output", async ({ page }) => {
    test.setTimeout(180_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WS["flood-1"]);
    await workspacePage.waitForReady();
    for (const [i, branch] of ["flood-1", "flood-2", "flood-3"].entries()) {
      if (i > 0) await workspacePage.switchWorkspace(WS[branch]);
      await openTerminal(workspacePage, WS[branch]);
      await workspacePage.typeInPane(0, FLOOD);
    }
    await workspacePage.switchWorkspace(WS.parked);
    await openTerminal(workspacePage, WS.parked);
    await workspacePage.focusPane(0);
    await measure(workspacePage, "parked");
  });
});
