/**
 * Power saver: on battery, or with the window blurred, the UI stops its continuous work.
 *
 * Infinite animations pause (the agent status marks pulse while plugged in and focused), a focused
 * terminal's cursor stops blinking, and a parked terminal stops parsing its output, which the
 * server's snapshot replays when the terminal is shown. The battery state comes from a stand-in
 * for the browser's Battery Status API (`PowerSaverPage.installBattery`); the desktop shell feeds
 * the same state from Electron's powerMonitor. Real server, real PTYs.
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
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { PowerSaverPage } from "./pages/PowerSaverPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-power-saver-token";
const REPO_A = "alpha-power-saver";
const REPO_B = "bravo-power-saver";
const WORKTREE_A = toWorktreeId(REPO_A, "main", "local");
const WORKTREE_B = toWorktreeId(REPO_B, "main", "local");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
const workdirs: string[] = [];

function makeGitWorkdir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: gitEnv });
  workdirs.push(dir);
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
  const a = makeGitWorkdir("band-power-saver-a-");
  const b = makeGitWorkdir("band-power-saver-b-");
  seedState(tmpHome, {
    repos: [
      { name: REPO_A, path: a, defaultBranch: "main", worktrees: [{ branch: "main", path: a }] },
      { name: REPO_B, path: b, defaultBranch: "main", worktrees: [{ branch: "main", path: b }] },
    ],
  });
  // DOM renderer so the rendered rows are readable.
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  for (const dir of workdirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("infinite animations run plugged in and focused, and stop on battery or when blurred", async ({
  page,
}) => {
  const power = new PowerSaverPage(page);
  await power.installBattery(false);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await worktree.goto(WORKTREE_A);
  await worktree.waitForReady();

  // A "question" mark pulses for as long as it shows. The status stream has no replay, so re-send.
  await expect
    .poll(
      async () => {
        await worktree.setAgentStatus(WORKTREE_A, "question");
        return worktree.agentStatusDot(WORKTREE_A).getAttribute("data-status");
      },
      { timeout: 15_000 },
    )
    .toBe("question");

  await expect.poll(() => power.runningInfiniteAnimations()).toContain("status-pulse");
  expect(await power.powerAttribute()).toBeNull();

  await power.setOnBattery(true);
  await expect.poll(() => power.powerAttribute()).toBe("saver");
  await expect.poll(() => power.runningInfiniteAnimations()).toEqual([]);

  await power.setOnBattery(false);
  await expect.poll(() => power.runningInfiniteAnimations()).toContain("status-pulse");

  await power.blur();
  await expect.poll(() => power.runningInfiniteAnimations()).toEqual([]);
  await power.focus();
  await expect.poll(() => power.runningInfiniteAnimations()).toContain("status-pulse");
});

test("a focused terminal's cursor blinks plugged in and stops on battery", async ({ page }) => {
  const power = new PowerSaverPage(page);
  await power.installBattery(false);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await worktree.goto(WORKTREE_A);
  await worktree.waitForReady();
  await worktree.openTerminalTab();
  await worktree.waitForTerminalReady(20_000);

  await expect.poll(() => power.terminalCursorBlinks(WORKTREE_A)).toBe(true);
  await power.setOnBattery(true);
  await expect.poll(() => power.terminalCursorBlinks(WORKTREE_A)).toBe(false);
  await power.setOnBattery(false);
  await expect.poll(() => power.terminalCursorBlinks(WORKTREE_A)).toBe(true);
});

test("a parked terminal does not parse output on battery and shows it when shown again", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const power = new PowerSaverPage(page);
  await power.installBattery(true);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const socketCount = worktree.trackTerminalSocketOpensFor(WORKTREE_A);

  await worktree.goto(WORKTREE_A);
  await worktree.waitForReady();
  await worktree.openTerminalTab();
  await expect(worktree.terminalTabVisibilityMarker(WORKTREE_A, true)).toBeVisible({
    timeout: 20_000,
  });
  await worktree.waitForTerminalReady(20_000);
  await worktree.waitForTerminalRenderedPrompt(WORKTREE_A);
  await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

  // The output waits for a gate, created only once A is parked. The quoted fragments and `$((40+2))`
  // keep the typed command line from matching the markers.
  await worktree.runInTerminalUntilRendered(
    WORKTREE_A,
    `echo GATE_"ARMED"; sleep 4; echo PARKED_DONE_$((40+2))`,
    /GATE_ARMED/,
  );
  await worktree.switchWorktree(WORKTREE_B);
  await expect(worktree.terminalTabVisibilityMarker(WORKTREE_B, true)).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => worktree.isTerminalParked(WORKTREE_A), { timeout: 20_000 }).toBe(true);
  // The output reaches the server's scrollback while A is parked.
  await expect
    .poll(() => serverOutput(WORKTREE_A), { timeout: 30_000 })
    .toContain("PARKED_DONE_42");

  await worktree.switchWorktree(WORKTREE_A);
  await expect(worktree.terminalTabVisibilityMarker(WORKTREE_A, true)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      async () => (await worktree.readTerminalRenderedText(WORKTREE_A)).includes("PARKED_DONE_42"),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
  // Replayed from the server's snapshot over a second socket, not parsed while parked.
  expect(socketCount()).toBe(2);
});
