/**
 * band-app/band#617 — persistent xterm cache with a DOM "parking" model.
 *
 * This spec proves the core switch behaviour the parking model guarantees:
 * switching a workspace away and back does NOT recreate the terminal. The one
 * xterm instance is kept alive, its surface *moved* to an off-screen parking
 * container while inactive and moved back on return — so on switch-back the
 * SAME WebGL backing store is reused (correctly sized, repainted) and NO new
 * terminal socket is opened. That is the root-cause fix for the garble-on-
 * switch bug (#615), replacing the old "hide in place + repair on show" dance.
 *
 * Doctrine: real production server, real PTYs (git-init'd dirs → "git" projects
 * with clickable sidebar cards + a real cwd), no tRPC mocking, no `page.route`
 * on our own routes. WebGL is forced on via SwiftShader launch flags so xterm
 * attaches a real <canvas> (otherwise the surface-reuse assertion is vacuous).
 * Driven entirely through `WorkspacePage`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-parking-switch-token";

const PROJECT_A = "alpha-parking-switch";
const PROJECT_B = "bravo-parking-switch";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
    ],
  },
});

let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
let workdirB!: string;

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function makeGitWorkdir(prefix: string, home: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env = makeGitEnv(home);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdirA = makeGitWorkdir("band-parking-switch-a-", tmpHome);
  workdirB = makeGitWorkdir("band-parking-switch-b-", tmpHome);
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
  // Pin the LRU high enough that a plain A↔B switch keeps A cached (parked),
  // not evicted — parking is what this spec exercises.
  seedSettings(tmpHome, { tokenSecret: TOKEN, maxCachedWorkspaces: 3 });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdirA) rmSync(workdirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (workdirB) rmSync(workdirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal parking: workspace switch reuses the cached xterm", () => {
  test("switching back to a cached workspace reuses the parked surface with no new socket and no manual resize", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    // Count terminal sockets for workspace A specifically (B's socket must not
    // be conflated) from before the first navigation.
    const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });

    // A's WebGL surface attaches while visible. Also the WebGL precondition:
    // without SwiftShader the DOM renderer would attach no <canvas> and this
    // poll would fail loudly rather than pass vacuously.
    await expect
      .poll(
        async () => (await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A)).canvasCount,
        {
          timeout: 20_000,
        },
      )
      .toBeGreaterThan(0);

    // Exactly one terminal socket so far (A's).
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);
    const socketsAfterA = socketCount();

    // Tag A's canvases so we can prove the SAME surface is reused after the
    // round-trip switch (parking never disposes it).
    const tagged = await workspacePage.tagTerminalCanvasesByWorkspace(WORKSPACE_A);
    expect(tagged).toBeGreaterThan(0);

    // Switch to B (in-app sidebar nav keeps A cached). A parks off-screen.
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(true);

    // Switch back to A — the parking model moves the wrapper back and re-fits.
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(false);

    // The tagged canvases SURVIVE — the surface was reused, not rebuilt (the
    // inverse of the old in-place-repair model) — AND it's correctly sized to
    // the now-live container: every backing store matches the `.xterm-screen`
    // rect × dpr. All measurements are taken from ONE settled snapshot inside
    // the poll so a render flush between reads can't produce a stale mismatch.
    await expect
      .poll(
        async () => {
          const s = await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A);
          const reused = s.canvasCount > 0 && s.survivingTags === s.canvasCount;
          const sized =
            s.backing.length > 0 &&
            s.screen.w > 0 &&
            s.screen.h > 0 &&
            s.backing.every(
              (b) =>
                Math.abs(b.w - s.screen.w * s.dpr) <= 2 && Math.abs(b.h - s.screen.h * s.dpr) <= 2,
            );
          return reused && sized;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // No new terminal socket opened across the round-trip: the in-session
    // switch reused the live connection (no reconnect/replay). This is the
    // property that removes the replay-flicker for in-session switches while
    // leaving genuine reload / multi-client replay (#613) untouched.
    expect(socketCount()).toBe(socketsAfterA);
  });
});
