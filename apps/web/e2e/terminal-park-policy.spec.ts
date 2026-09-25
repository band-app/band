/**
 * Terminal renderer parking policy (ported from orca's hidden-view parking,
 * `apps/web/src/lib/terminal-park-policy.ts`).
 *
 * Every visited workspace stays mounted, so terminal memory is bounded by
 * time and count instead: a hidden workspace's terminals stay warm for 30 s,
 * the 4 most recently hidden workspaces stay warm for 5 minutes, and the
 * workspace the user most recently left stays warm indefinitely. Past that the
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

const TOKEN = "e2e-terminal-park-policy-token";
const PROJECT = "park-policy-repo";

// Server-side PTYs outlive a test's page, so each test uses its own worktrees.
const BRANCHES = Array.from({ length: 11 }, (_, i) => `park-${i}`);
const WS = BRANCHES.map((branch) => toWorkspaceId(PROJECT, branch));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# park policy\n");
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
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

/** Show a workspace's terminal and wait until its xterm is live and marked. */
async function showTerminal(workspacePage: WorkspacePage, workspaceId: string): Promise<void> {
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(workspaceId, true)).toBeVisible({
    timeout: 20_000,
  });
  await workspacePage.waitForTerminalRenderedPrompt(workspaceId);
  expect(await workspacePage.markTerminalWrappers(workspaceId)).toBe(1);
}

async function openFirst(workspacePage: WorkspacePage, workspaceId: string): Promise<void> {
  await workspacePage.goto(workspaceId);
  await workspacePage.waitForReady();
  await showTerminal(workspacePage, workspaceId);
}

async function switchTo(workspacePage: WorkspacePage, workspaceId: string): Promise<void> {
  await workspacePage.switchWorkspace(workspaceId);
  await showTerminal(workspacePage, workspaceId);
}

test.describe("Terminal parking policy", () => {
  test("only the 4 most recently hidden workspaces stay warm, and only after 30 s hidden", async ({
    page,
  }) => {
    // Open the oldest, then four more, then land on a sixth: five hidden
    // workspaces, one over the warm budget of 4.
    const [oldest, ...recent] = WS.slice(0, 5);
    const active = WS[5];
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.installClock();

    await openFirst(workspacePage, oldest);
    // The fake clock keeps flowing in real time while the switches run, so
    // measure the thresholds from just before the oldest is hidden (the hide
    // lands a click later, so `elapsed` never undercounts).
    const oldestHiddenAt = await workspacePage.clockNow();
    for (const id of recent) await switchTo(workspacePage, id);
    await switchTo(workspacePage, active);
    const elapsed = (await workspacePage.clockNow()) - oldestHiddenAt;
    expect(elapsed).toBeLessThan(29 * SECOND);

    // Under the 30 s delay nothing is disposed, even over budget.
    await workspacePage.advanceClock(29 * SECOND - elapsed);
    expect(await workspacePage.markedTerminalWrapperCount(oldest)).toBe(1);

    // Past it, the oldest falls outside the 4 most recently hidden.
    await workspacePage.advanceClock(2 * SECOND);
    await expect
      .poll(() => workspacePage.terminalWrapperCount(oldest), { timeout: 10_000 })
      .toBe(0);
    for (const id of recent) {
      expect(await workspacePage.markedTerminalWrapperCount(id)).toBe(1);
    }
  });

  test("past the 5 minute window a hidden workspace's terminal is disposed, and reveal replays its output", async ({
    page,
  }) => {
    const [a, b, c] = [WS[6], WS[7], WS[8]];
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.installClock();
    const socketOpensA = workspacePage.trackTerminalSocketOpensFor(a);

    await openFirst(workspacePage, a);
    await workspacePage.runInTerminalUntilRendered(
      a,
      "echo PARK_POLICY_$((6*7))",
      /PARK_POLICY_42/,
    );
    await expect.poll(() => socketOpensA(), { timeout: 20_000 }).toBe(1);
    await switchTo(workspacePage, b);
    await switchTo(workspacePage, c);

    // A and B are both hidden past the 5 minute window. B is the workspace
    // most recently left, so it is exempt; A is not.
    await workspacePage.advanceClock(5 * MINUTE + SECOND);

    await expect.poll(() => workspacePage.terminalWrapperCount(a), { timeout: 10_000 }).toBe(0);
    expect(await workspacePage.markedTerminalWrapperCount(b)).toBe(1);

    // Reveal A: a fresh terminal reattaches to the surviving PTY over a new
    // socket and replays the earlier output.
    await workspacePage.switchWorkspace(a);
    await expect(workspacePage.terminalTabVisibilityMarker(a, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        async () => (await workspacePage.readTerminalRenderedText(a)).includes("PARK_POLICY_42"),
        {
          timeout: 20_000,
        },
      )
      .toBe(true);
    expect(await workspacePage.markedTerminalWrapperCount(a)).toBe(0);
    expect(socketOpensA()).toBe(2);
  });

  test("the most recently left workspace stays warm however long it is hidden", async ({
    page,
  }) => {
    const [a, b] = [WS[9], WS[10]];
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.installClock();

    await openFirst(workspacePage, a);
    await switchTo(workspacePage, b);

    // Well past both the 30 s delay and the 5 minute window.
    await workspacePage.advanceClock(30 * MINUTE);

    expect(await workspacePage.markedTerminalWrapperCount(a)).toBe(1);
    expect(await workspacePage.isTerminalParked(a)).toBe(true);
  });
});
