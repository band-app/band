/**
 * Terminal renderer parking policy (ported from orca's hidden-view parking,
 * `apps/web/src/lib/terminal-park-policy.ts`).
 *
 * Every visited worktree stays mounted, so terminal memory is bounded by
 * time and count instead: a hidden worktree's terminals stay warm for 30 s,
 * the 4 most recently hidden worktrees stay warm for 5 minutes, and the
 * worktree the user most recently left stays warm indefinitely. Past that the
 * terminal is "cold parked": its xterm and socket are disposed while the
 * server PTY keeps running, and revealing it reconnects and replays.
 *
 * The thresholds are crossed with Playwright's fake clock (`installClock` /
 * `advanceClock` on the page object), not with test-only overrides in
 * production code.
 *
 * "Still warm" is proven by wrapper identity: the test marks a terminal's
 * wrapper element, and a disposed-then-recreated terminal comes back as a
 * fresh wrapper without the mark. DOM renderer (not WebGL) so printed output
 * lands in `.xterm-rows` where `readTerminalRenderedText` can read it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-park-policy-token";
const REPO = "park-policy-repo";

// Server-side PTYs outlive a test's page, so each test uses its own worktrees.
const BRANCHES = Array.from({ length: 12 }, (_, i) => `park-${i}`);
const WS = BRANCHES.map((branch) => toWorktreeId(REPO, branch));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# park policy\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  const worktrees = [{ branch: "main", path: repoPath }];
  for (const branch of BRANCHES) {
    const path = join(tmpHome, `${REPO}-${branch}`);
    gitInHome(repoPath, ["worktree", "add", "-q", "-b", branch, path], tmpHome);
    worktrees.push({ branch, path });
  }
  seedState(tmpHome, {
    repos: [{ name: REPO, path: repoPath, defaultBranch: "main", worktrees }],
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
});

/** Show a worktree's terminal and mark its wrapper. By default waits for the
 *  shell prompt; `waitForPrompt: false` only waits for the wrapper, which is
 *  all the mark needs and keeps a chain of switches fast on a loaded runner. */
async function showTerminal(
  worktreePage: WorktreePage,
  worktreeId: string,
  { waitForPrompt = true }: { waitForPrompt?: boolean } = {},
): Promise<void> {
  await worktreePage.openTerminalTab();
  await expect(worktreePage.terminalTabVisibilityMarker(worktreeId, true)).toBeVisible({
    timeout: 20_000,
  });
  if (waitForPrompt) await worktreePage.waitForTerminalRenderedPrompt(worktreeId);
  else {
    await expect
      .poll(() => worktreePage.terminalWrapperCount(worktreeId), { timeout: 20_000 })
      .toBe(1);
  }
  expect(await worktreePage.markTerminalWrappers(worktreeId)).toBe(1);
}

async function openFirst(worktreePage: WorktreePage, worktreeId: string): Promise<void> {
  await worktreePage.goto(worktreeId);
  await worktreePage.waitForReady();
  await showTerminal(worktreePage, worktreeId);
}

async function switchTo(
  worktreePage: WorktreePage,
  worktreeId: string,
  opts?: { waitForPrompt?: boolean },
): Promise<void> {
  await worktreePage.switchWorktree(worktreeId);
  await showTerminal(worktreePage, worktreeId, opts);
}

test.describe("Terminal parking policy", () => {
  test("only the 4 most recently hidden worktrees stay warm, and only after 30 s hidden", async ({
    page,
  }) => {
    // Open the oldest, then four more, then land on a sixth: five hidden
    // worktrees, one over the warm budget of 4.
    const [oldest, ...recent] = WS.slice(0, 5);
    const active = WS[5];
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.installClock();

    await openFirst(worktreePage, oldest);
    // The fake clock keeps flowing in real time while the switches run, so
    // measure the thresholds from just before the oldest is hidden (the hide
    // lands a click later, so `elapsed` never undercounts). The switches skip
    // the shell-prompt wait so they fit well inside the 30 s window.
    const oldestHiddenAt = await worktreePage.clockNow();
    for (const id of recent) await switchTo(worktreePage, id, { waitForPrompt: false });
    await switchTo(worktreePage, active, { waitForPrompt: false });
    const elapsed = (await worktreePage.clockNow()) - oldestHiddenAt;
    expect(elapsed).toBeLessThan(29 * SECOND);

    // Under the 30 s delay nothing is disposed, even over budget.
    await worktreePage.advanceClock(29 * SECOND - elapsed);
    expect(await worktreePage.markedTerminalWrapperCount(oldest)).toBe(1);

    // Move until even the last one hidden has been hidden 31 s (all five are
    // candidates, all under 5 minutes). Only the budget can dispose now: the
    // oldest falls outside the 4 most recently hidden, and those 4 stay warm.
    await worktreePage.advanceClock(elapsed + 2 * SECOND);
    await expect.poll(() => worktreePage.terminalWrapperCount(oldest), { timeout: 10_000 }).toBe(0);
    for (const id of recent) {
      expect(await worktreePage.markedTerminalWrapperCount(id)).toBe(1);
    }
  });

  test("past the 5 minute window a hidden worktree's terminal is disposed, and reveal replays its output", async ({
    page,
  }) => {
    const [a, b, c] = [WS[6], WS[7], WS[8]];
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.installClock();
    const socketOpensA = worktreePage.trackTerminalSocketOpensFor(a);

    await openFirst(worktreePage, a);
    await worktreePage.runInTerminalUntilRendered(a, "echo PARK_POLICY_$((6*7))", /PARK_POLICY_42/);
    await expect.poll(() => socketOpensA(), { timeout: 20_000 }).toBe(1);
    await switchTo(worktreePage, b);
    await switchTo(worktreePage, c);

    // A and B are both hidden past the 5 minute window. B is the worktree
    // most recently left, so it is exempt; A is not.
    await worktreePage.advanceClock(5 * MINUTE + SECOND);

    await expect.poll(() => worktreePage.terminalWrapperCount(a), { timeout: 10_000 }).toBe(0);
    expect(await worktreePage.markedTerminalWrapperCount(b)).toBe(1);

    // Reveal A: a fresh terminal reattaches to the surviving PTY over a new
    // socket and replays the earlier output.
    await worktreePage.switchWorktree(a);
    await expect(worktreePage.terminalTabVisibilityMarker(a, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        async () => (await worktreePage.readTerminalRenderedText(a)).includes("PARK_POLICY_42"),
        {
          timeout: 20_000,
        },
      )
      .toBe(true);
    expect(await worktreePage.markedTerminalWrapperCount(a)).toBe(0);
    expect(socketOpensA()).toBe(2);
  });

  test("the most recently left worktree stays warm however long it is hidden", async ({ page }) => {
    const [a, b] = [WS[9], WS[10]];
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.installClock();

    await openFirst(worktreePage, a);
    await switchTo(worktreePage, b);

    // Well past both the 30 s delay and the 5 minute window.
    await worktreePage.advanceClock(30 * MINUTE);

    expect(await worktreePage.markedTerminalWrapperCount(a)).toBe(1);
    expect(await worktreePage.isTerminalParked(a)).toBe(true);
  });
  test("inside a worktree, a terminal tab hidden past 5 minutes is disposed unless it was hidden last", async ({
    page,
  }) => {
    const ws = WS[11];
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.installClock();
    // Per terminal: after the 5 minute jump the other tabs' heartbeats see a
    // stale pong and reconnect, which says nothing about the first tab.
    const socketOpens = worktreePage.trackTerminalSocketOpensByTerminal();

    // Three terminal tabs; the first gets output we look for after a replay.
    await openFirst(worktreePage, ws);
    const [first] = await worktreePage.terminalIds(ws);
    await worktreePage.runInTerminalUntilRendered(ws, "echo TAB_PARK_$((6*7))", /TAB_PARK_42/);
    await worktreePage.clickTerminalAddTab(ws);
    await expect.poll(() => worktreePage.terminalWrapperCount(ws), { timeout: 20_000 }).toBe(2);
    const second = (await worktreePage.terminalIds(ws)).find((id) => id !== first);
    await worktreePage.clickTerminalAddTab(ws);
    await expect.poll(() => worktreePage.terminalWrapperCount(ws), { timeout: 20_000 }).toBe(3);
    const third = (await worktreePage.terminalIds(ws)).find((id) => id !== first && id !== second);
    if (!second || !third) throw new Error("expected three terminal ids");
    for (const id of [first, second, third]) await worktreePage.markTerminalWrapper(id);
    const opensBefore = socketOpens(first);

    // The first and second tabs are hidden; the second was hidden last, so it
    // is exempt. The third is on screen.
    await worktreePage.advanceClock(5 * MINUTE + SECOND);

    await expect
      .poll(() => worktreePage.terminalWrapperState(first), { timeout: 10_000 })
      .toBe("absent");
    expect(await worktreePage.terminalWrapperState(second)).toBe("marked");
    expect(await worktreePage.terminalWrapperState(third)).toBe("marked");

    // Revealing the first tab reattaches a fresh terminal that replays output.
    await worktreePage.activateTerminalTab(0);
    await expect
      .poll(async () => (await worktreePage.readTerminalRenderedText(ws)).includes("TAB_PARK_42"), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(await worktreePage.terminalWrapperState(first)).toBe("unmarked");
    expect(socketOpens(first)).toBe(opensBefore + 1);
  });
});
