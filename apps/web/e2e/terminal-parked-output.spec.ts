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
 * DOM renderer so the rendered rows are readable. Real server, real PTYs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-parked-output-token";
const PROJECT_A = "alpha-parked-output";
const PROJECT_B = "bravo-parked-output";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

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

/** The server-side scrollback of the workspace's only terminal. */
async function serverOutput(workspaceId: string): Promise<string> {
  const { terminals } = await trpcQuery<{ terminals: { terminalId: string }[] }>(
    server.url,
    TOKEN,
    "terminal.list",
    { workspaceId },
  );
  if (terminals.length !== 1) return "";
  const { output } = await trpcQuery<{ output: string }>(server.url, TOKEN, "terminal.output", {
    terminalId: terminals[0].terminalId,
  });
  return output;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const workdirA = makeGitWorkdir("band-parked-output-a-");
  const workdirB = makeGitWorkdir("band-parked-output-b-");
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT_A,
        path: workdirA,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirA }],
      },
      {
        name: PROJECT_B,
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
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

  await workspacePage.goto(WORKSPACE_A);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
    timeout: 20_000,
  });
  await workspacePage.waitForTerminalReady(20_000);
  await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE_A);
  await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

  // The sleep gives the switch below time to park A before the flood starts.
  // `$((40+2))` keeps the typed command line from matching the marker.
  await workspacePage.runInTerminal("sleep 3; seq 1 600000; echo PARKED_DONE_$((40+2))");

  await workspacePage.switchWorkspace(WORKSPACE_B);
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
    .toBe(true);

  // The whole flood (~4 MB, twice the queue cap) reached A while it was parked.
  await expect
    .poll(async () => (await serverOutput(WORKSPACE_A)).includes("PARKED_DONE_42"), {
      timeout: 30_000,
    })
    .toBe(true);

  await workspacePage.switchWorkspace(WORKSPACE_A);
  await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes("PARKED_DONE_42"),
      { timeout: 20_000 },
    )
    .toBe(true);
  // Resynced over a second socket rather than parsing the dropped backlog.
  expect(socketCount()).toBe(2);
});
