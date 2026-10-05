/**
 * Output of a parked terminal (`src/lib/terminal-output-queue.ts`).
 *
 * A parked terminal no longer parses every WebSocket frame as it arrives: its
 * output is queued and drained on a budget, so a streaming background
 * terminal can't starve keystroke echo in the visible one. A queue that grows
 * past its cap (2 MB) stops parsing, and the terminal is resynced from the
 * server's serialized snapshot when it is shown again.
 *
 * This spec covers the overflow path: a parked terminal prints ~4 MB, then a
 * marker. Once the server has the marker, revealing the terminal must show it
 * (nothing lost) over a fresh socket (the resync reconnected). The small-output
 * path, drained in place over the same socket, is covered by
 * `terminal-parking-output-focus.spec.ts`.
 *
 * It also checks that a parked terminal acknowledges its output on receipt
 * (`terminal-cache.ts`): the flood must never pause long enough to hit the
 * server's 5 s stall timeout, which is what a parked terminal that withheld
 * its acks would cost (`api/terminals/output-flow.ts`). The check is the
 * longest gap between two polls that saw the flood's `seq` number climb.
 *
 * DOM renderer so the rendered rows are readable. Real server, real PTYs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitEnv } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-parked-output-token";
const REPO_A = "alpha-parked-output";
const REPO_B = "bravo-parked-output";
const WORKTREE_A = toWorktreeId(REPO_A, "main");
const WORKTREE_B = toWorktreeId(REPO_B, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
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

/** The last complete line of `seq` output in `output`, or -1. Only `seq`
 *  prints a line of nothing but digits. */
function lastSeqNumber(output: string): number {
  const lines = [...output.slice(-512).matchAll(/^(\d+)\r?\n/gm)];
  return lines.length ? Number(lines[lines.length - 1][1]) : -1;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdirA = makeGitWorkdir("band-parked-output-a-");
  const workdirB = makeGitWorkdir("band-parked-output-b-");
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_A,
        path: workdirA,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirA }],
      },
      {
        name: REPO_B,
        path: workdirB,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirB }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  for (const dir of workdirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a parked terminal that overflows its output queue is resynced when shown", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const socketCount = worktreePage.trackTerminalSocketOpensFor(WORKTREE_A);

  await worktreePage.goto(WORKTREE_A);
  await worktreePage.waitForReady();
  await worktreePage.openTerminalTab();
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_A, true)).toBeVisible({
    timeout: 20_000,
  });
  await worktreePage.waitForTerminalReady(20_000);
  await worktreePage.waitForTerminalRenderedPrompt(WORKTREE_A);
  await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

  // The flood waits for a gate file, created only once A is parked. The
  // quoted fragments and `$((40+2))` keep the typed command line from
  // matching either marker.
  const gate = join(workdirA, "go");
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE_A,
    `echo GATE_"ARMED"; while [ ! -e ${gate} ]; do sleep 0.1; done; seq 1 600000; echo PARKED_DONE_$((40+2))`,
    /GATE_ARMED/,
  );

  await worktreePage.switchWorktree(WORKTREE_B);
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_B, true)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => worktreePage.isTerminalParked(WORKTREE_A), { timeout: 20_000 })
    .toBe(true);
  writeFileSync(gate, "");

  // The whole flood (~4 MB, twice the queue cap) reached A while it was
  // parked, and without once waiting out the 5 s stall timeout. A stall
  // freezes the PTY, so the last `seq` number stops climbing for 5 s; a slow
  // runner only makes it climb slower. A total-time budget can't tell the two
  // apart, so measure the longest gap between two polls that saw progress.
  let lastSeq = -1;
  let lastProgressAt = Date.now();
  let longestGap = 0;
  await expect
    .poll(
      async () => {
        const output = await serverOutput(WORKTREE_A);
        const done = output.includes("PARKED_DONE_42");
        const seq = lastSeqNumber(output);
        if (seq > lastSeq || done) {
          longestGap = Math.max(longestGap, Date.now() - lastProgressAt);
          lastSeq = seq;
          lastProgressAt = Date.now();
        }
        return done;
      },
      { timeout: 30_000, intervals: [100] },
    )
    .toBe(true);
  expect(longestGap).toBeLessThan(4_000);

  await worktreePage.switchWorktree(WORKTREE_A);
  await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_A, true)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        (await worktreePage.readTerminalRenderedText(WORKTREE_A)).includes("PARKED_DONE_42"),
      { timeout: 20_000 },
    )
    .toBe(true);
  // Resynced over a second socket rather than parsing the dropped backlog.
  expect(socketCount()).toBe(2);
});
