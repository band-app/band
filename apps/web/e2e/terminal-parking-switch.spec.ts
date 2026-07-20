/**
 * band-app/band#617 — persistent xterm cache with a DOM "parking" model.
 *
 * This spec proves the core switch behaviour the parking model guarantees:
 * switching a workspace away and back does NOT recreate the terminal. The one
 * xterm instance is kept alive (same terminal id, same wrapper, NO new terminal
 * socket), its surface *moved* to an off-screen parking container while
 * inactive and moved back on return.
 *
 * The WebGL *renderer* inside that surface is REUSED across the round-trip too.
 * Because the wrapper is parked off-screen but still PAINTED (see
 * terminal-parking.ts), the GPU backing store survives a plain workspace switch
 * / foreground return / click, so those paths do a cheap fit + refresh and keep
 * the same <canvas> — no rebuild, no blank-then-repaint flicker (the fallout of
 * the #631/#634/#637 repair machinery this relaxes). The addon is rebuilt ONLY
 * on a genuine `webglcontextlost` event (`onContextLoss`) or a desktop
 * `system-resumed` wake (sleep/unlock texture loss). This spec asserts: terminal
 * reused, surface reused on switch/foreground/click, surface rebuilt on real
 * context loss.
 *
 * Doctrine: real production server, real PTYs (git-init'd dirs → "git" projects
 * with clickable sidebar cards + a real cwd), no tRPC mocking, no `page.route`
 * on our own routes. WebGL is forced on via SwiftShader launch flags so xterm
 * attaches a real <canvas> (otherwise the reuse/rebuild assertions are vacuous).
 * Driven entirely through `WorkspacePage`.
 *
 * Not covered here: the `system-resumed` rebuild path is a desktop (Electron)
 * IPC event — `isDesktop` is false in this browser harness, so that listener
 * isn't registered and can't be exercised. It shares the exact rebuild code the
 * `onContextLoss` test drives (both set `webglSuspect` → `scheduleRepair`).
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
  test("switching back to a cached workspace reuses the terminal (no new socket) and its WebGL surface (no rebuild)", async ({
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

    // Remember A's terminal identity so we can prove the terminal itself is
    // REUSED across the round-trip (same session, not a recreated one), and
    // tag A's canvases so we can prove the WebGL renderer is REBUILT.
    const idsBefore = await workspacePage.terminalIds(WORKSPACE_A);
    expect(idsBefore.length).toBeGreaterThan(0);
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

    // Wait for re-attach to SETTLE: the backing store gets sized to the
    // now-live container by the fit inside `repairAndFit` — the exact pass
    // where a rebuild, if any, fires. Polling on `sized` therefore guarantees
    // that pass ran before we judge the surface (a bare `survivingTags > 0`
    // poll would short-circuit on the pre-repair frame and pass vacuously).
    await expect
      .poll(
        async () => {
          const s = await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A);
          return (
            s.canvasCount > 0 &&
            s.backing.length > 0 &&
            s.screen.w > 0 &&
            s.screen.h > 0 &&
            s.backing.every(
              (b) =>
                Math.abs(b.w - s.screen.w * s.dpr) <= 2 && Math.abs(b.h - s.screen.h * s.dpr) <= 2,
            )
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // Now that the re-attach pass has run, the tagged canvas SURVIVES — the
    // parked surface stayed painted off-screen, so re-attach reused the same
    // WebGL <canvas> (cheap fit + refresh, no rebuild, no switch-back flicker).
    // On the pre-relaxation code re-attach rebuilt the addon and this was 0.
    const settled = await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A);
    expect(settled.survivingTags).toBeGreaterThan(0);

    // The terminal SESSION was reused: same terminal id backs the same wrapper.
    expect(await workspacePage.terminalIds(WORKSPACE_A)).toEqual(idsBefore);

    // No new terminal socket opened across the round-trip: the in-session
    // switch reused the live connection (no reconnect/replay). This is the
    // property that removes the replay-flicker for in-session switches while
    // leaving genuine reload / multi-client replay (#613) untouched.
    expect(socketCount()).toBe(socketsAfterA);
  });

  test("returning to the foreground repaints the terminal without rebuilding its WebGL surface or reconnecting", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        async () => (await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A)).canvasCount,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

    const tagged = await workspacePage.tagTerminalCanvasesByWorkspace(WORKSPACE_A);
    expect(tagged).toBeGreaterThan(0);

    // A foreground return (window `focus`, also fired by visibility un-hide)
    // does a CHEAP repaint only — fit + refresh — and must NOT rebuild the WebGL
    // addon. Rebuilding on ordinary focus raced the compositor and flickered;
    // an off-screen parked surface stays painted, so the GPU context is intact.
    await workspacePage.simulateWindowForeground();
    // Let the rAF-debounced repair actually run — a rebuild (pre-relaxation
    // behavior) would land within a couple of frames of the event; waiting past
    // that window is what makes the "surface survived" assertion non-vacuous.
    await workspacePage.settleAnimationFrames(6);

    // The tagged canvas SURVIVES (same surface, reused) and stays correctly
    // sized. On the pre-relaxation code this went red — focus rebuilt the addon
    // and the tags vanished.
    const s = await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A);
    expect(s.survivingTags).toBeGreaterThan(0);
    expect(s.canvasCount).toBeGreaterThan(0);
    expect(s.backing.length).toBeGreaterThan(0);
    expect(
      s.backing.every(
        (b) => Math.abs(b.w - s.screen.w * s.dpr) <= 2 && Math.abs(b.h - s.screen.h * s.dpr) <= 2,
      ),
    ).toBe(true);

    // Renderer-only cheap repaint: no reconnect, no fresh shell.
    expect(socketCount()).toBe(1);
  });

  test("focus entering the terminal does not rebuild its WebGL surface or reconnect", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        async () => (await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A)).canvasCount,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

    const tagged = await workspacePage.tagTerminalCanvasesByWorkspace(WORKSPACE_A);
    expect(tagged).toBeGreaterThan(0);

    // Clicking into the terminal (blur + refocus → `focusin`) now does a cheap
    // repaint at most, never a rebuild: recreating the surface on a click raced
    // the compositor and flickered, and a click is not evidence of GPU
    // corruption. Drive the gesture a few times (each is >1s past the initial
    // addon build, so the throttle doesn't suppress the cheap repaint path we
    // want to exercise), settling frames after each so a would-be rebuild lands.
    for (let i = 0; i < 3; i++) {
      await workspacePage.refocusTerminal();
      await workspacePage.settleAnimationFrames(4);
    }

    // The tagged canvas SURVIVES throughout — no click ever rebuilt it. On the
    // pre-relaxation code this went red: the click rebuilt the addon and the
    // tags vanished.
    const s = await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A);
    expect(s.survivingTags).toBeGreaterThan(0);
    expect(s.canvasCount).toBeGreaterThan(0);

    // No reconnect, no fresh shell.
    expect(socketCount()).toBe(1);
  });

  test("a genuine WebGL context loss rebuilds the surface without reconnecting", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        async () => (await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A)).canvasCount,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

    const tagged = await workspacePage.tagTerminalCanvasesByWorkspace(WORKSPACE_A);
    expect(tagged).toBeGreaterThan(0);

    // Force a REAL `webglcontextlost` — the one signal that legitimately
    // rebuilds the surface (xterm's WebglAddon.onContextLoss disposes and
    // reattaches). This is the genuine-loss counterpart to the reuse tests
    // above: the tagged canvas is replaced by a fresh, correctly-sized one.
    await workspacePage.loseTerminalWebglContext(WORKSPACE_A);

    await expect
      .poll(
        async () => {
          const s = await workspacePage.readTerminalSurfaceByWorkspace(WORKSPACE_A);
          const rebuilt = s.canvasCount > 0 && s.survivingTags === 0;
          const sized =
            s.backing.length > 0 &&
            s.screen.w > 0 &&
            s.screen.h > 0 &&
            s.backing.every(
              (b) =>
                Math.abs(b.w - s.screen.w * s.dpr) <= 2 && Math.abs(b.h - s.screen.h * s.dpr) <= 2,
            );
          return rebuilt && sized;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // The rebuild is renderer-only: no reconnect, no fresh shell.
    expect(socketCount()).toBe(1);
  });
});
