/**
 * Regression coverage for the "terminal scrollbar lost after zooming while in
 * a cached background workspace" bug.
 *
 * The bug
 * -------
 * App-zoom (Cmd+= / Cmd+-) and DPR-change events broadcast to EVERY mounted
 * `TerminalPanel` — including terminals in cached background workspaces the
 * `MultiWorkspacePanelHost` LRU keeps mounted under `visibility: hidden`.
 * When the `remeasureAndReattach` dance runs on a HIDDEN panel it disposes +
 * re-attaches the WebGL surface and runs `fit()` against a hidden / degenerate
 * layout — the same hazard a first-paint-while-hidden hits.
 *
 * But `firstVisiblePaintDoneRef` was already `true` (set when the terminal
 * took its FIRST paint while visible), so the one-shot become-visible repair
 * was considered "already done". On switching back, the become-visible effect
 * took the cheap `else` branch (a bare `fitAddon.fit()`), which early-returns
 * when cols/rows are unchanged — no reflow, no renderer repaint — leaving the
 * surface built while hidden on screen with its scrollbar missing until a
 * manual resize forced a real reflow.
 *
 * The fix (`TerminalPanel.tsx`)
 * -----------------------------
 * `remeasureAndReattach` now re-arms the one-shot repair
 * (`firstVisiblePaintDoneRef.current = false`) whenever it runs while the
 * panel is hidden. So the next become-visible does a FULL re-measure +
 * WebGL re-attach (disposing the surface built while hidden, sizing a fresh
 * <canvas> against the live layout) instead of a bare `fit()`.
 *
 * How this test discriminates old vs new code
 * -------------------------------------------
 * The difference between pre-fix and post-fix code is the surface REBUILD on
 * become-visible after a hidden-while-zoomed re-attach — the exact action that
 * repairs the corruption in production. The visible scrollbar is a GPU-pixel
 * artifact not reproducible in headless Chromium (see the sibling
 * `terminal-background-repaint.spec.ts` for the empirical reasons), so we
 * observe the rebuild instead: tag the canvases of the surface re-attached
 * while hidden, switch the workspace to the foreground, and assert the tags
 * are gone (a brand-new backing store). Pre-fix code only calls `fit()` and
 * leaves the tagged canvases in place, so this fails before the fix and passes
 * after.
 *
 * Crucial precondition vs the sibling spec
 * ----------------------------------------
 * Here workspace A's terminal takes its first paint while VISIBLE (we open the
 * Terminal tab while A is active), so `firstVisiblePaintDoneRef` starts `true`
 * and the sibling's first-paint-while-hidden repair does NOT apply. The ONLY
 * thing that re-arms the repair in this scenario is the new hidden-zoom guard,
 * which is exactly what this test exercises.
 *
 * Doctrine notes
 * --------------
 *  - Real production server (`startServer`), real PTYs (the two projects are
 *    `git init`-ed real dirs so they classify as "git", which renders the
 *    sidebar cards `switchWorkspace` needs and gives the PTY a real cwd).
 *  - No tRPC mocking, no `page.route` on our own routes. Zoom is driven through
 *    the real production keyboard shortcut (`WorkspacePage.zoomInViaShortcut`),
 *    not by poking CSS. The only external-boundary control is the Chromium
 *    launch flags that turn on SwiftShader WebGL.
 *  - Driven entirely through `WorkspacePage`.
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

const TOKEN = "e2e-terminal-zoom-hidden-token";

const PROJECT_A = "alpha-zoom-hidden";
const PROJECT_B = "bravo-zoom-hidden";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview (which
// hosts the terminal container) renders. The WebGL flags force the SwiftShader
// renderer on so xterm attaches a real <canvas> — without them headless
// Chromium falls back to xterm's DOM renderer and there is no surface to
// rebuild, which would make this test vacuous.
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

// Definite-assignment: all four are set in `beforeAll`. The `!` lets
// `afterAll` reference them while still guarding `server` (the only one that
// can be left unassigned if `startServer` throws mid-boot).
let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
let workdirB!: string;

/** Hermetic git environment: an explicit allowlist (no `process.env` spread)
 *  with `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at /dev/null so a
 *  contributor's host git config can't leak in and hang or skew the setup.
 *  Mirrors `terminal-background-repaint.spec.ts`. */
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

/** A `git init`-ed temp dir: real on disk (so the PTY can spawn with it as
 *  cwd) and containing a `.git` (so the project classifies as "git" and the
 *  sidebar renders a clickable workspace card for its default branch).
 *  `init -b main` forces the initial branch name so a host whose git defaults
 *  to `master` doesn't make the worktree poller rewrite the seeded `main`. */
function makeGitWorkdir(prefix: string, home: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env = makeGitEnv(home);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdirA = makeGitWorkdir("band-zoom-hidden-a-", tmpHome);
  workdirB = makeGitWorkdir("band-zoom-hidden-b-", tmpHome);
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
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  // Guard `server`: if `startServer` threw mid-boot it's unassigned, and a
  // bare `server.close()` would mask the real boot failure with a TypeError.
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdirA) rmSync(workdirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (workdirB) rmSync(workdirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal zoom while in a cached background workspace", () => {
  test("zooming while a terminal is hidden rebuilds its WebGL surface when it becomes visible again", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Land on A and open its Terminal tab WHILE A IS ACTIVE/VISIBLE. This is
    // the discriminating precondition vs the sibling spec: A's terminal takes
    // its first paint visible, so `firstVisiblePaintDoneRef` starts `true` and
    // the first-paint-while-hidden repair does NOT apply.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });

    // Wait for A's terminal to attach its WebGL surface while visible. This
    // also asserts the WebGL precondition: without SwiftShader the addon would
    // fall back to the DOM renderer, no <canvas> would exist, and this poll
    // would (correctly) fail loudly rather than the test passing vacuously.
    await expect
      .poll(async () => (await workspacePage.readTerminalSurface(WORKSPACE_A)).canvasCount, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    // Switch to B via the sidebar. A stays MOUNTED in the LRU cache but
    // inactive (`wsActive=false`), so A's terminal flips visible → hidden. In-
    // app navigation (sidebar click), not `goto()`, is what keeps A cached.
    await workspacePage.switchWorkspace(WORKSPACE_B);
    // Positive anchor (TEST-25): confirm B is actually active/visible before
    // proceeding — a sidebar click can land on B's route before B's panels
    // finish rendering, and we don't want to zoom/re-tag while B's layout is
    // still settling. Pair it with the A-hidden assertion below.
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, false)).toBeAttached({
      timeout: 20_000,
    });

    // Zoom in via the real keyboard shortcut. `band:zoom-changed` fires on
    // EVERY mounted terminal, so A's HIDDEN terminal runs `remeasureAndReattach`
    // against a hidden layout — re-attaching a fresh (suspect) WebGL surface.
    // This is the event the fix's re-arm hooks.
    await workspacePage.zoomInViaShortcut();

    // Wait for A's hidden surface to settle after the zoom re-attach, then tag
    // its canvases. These tags ride on the surface built while hidden.
    await expect
      .poll(async () => (await workspacePage.readTerminalSurface(WORKSPACE_A)).canvasCount, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const tagged = await workspacePage.tagTerminalCanvases(WORKSPACE_A);
    expect(tagged).toBeGreaterThan(0);

    // Bring A back to the foreground and re-activate its Terminal tab so A's
    // terminal flips hidden → visible — the become-visible transition the fix
    // hooks.
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });

    // The discriminating assertion: with the fix, the hidden-zoom re-armed the
    // one-shot repair, so become-visible disposes the surface built while
    // hidden and re-attaches a fresh WebGL addon — none of the tagged canvases
    // survive. Pre-fix, `firstVisiblePaintDoneRef` stayed `true`, so become-
    // visible only called `fit()` (resizing the SAME canvases at most) and the
    // tags would survive → this poll times out → the test fails before the fix.
    await expect
      .poll(async () => (await workspacePage.readTerminalSurface(WORKSPACE_A)).survivingTags, {
        timeout: 20_000,
      })
      .toBe(0);

    // Positive correctness anchor: the rebuilt surface is sized to the now-
    // visible container — its WebGL backing store matches the `.xterm-screen`
    // rect (× devicePixelRatio). A surface left sized to the hidden layout
    // would mismatch here. Poll until the screen rect has settled to a non-zero
    // size before asserting, so a snapshot taken mid-layout can't read 0×0.
    await expect
      .poll(
        async () => {
          const s = await workspacePage.readTerminalSurface(WORKSPACE_A);
          return s.canvasCount > 0 && s.screen.w > 0 && s.screen.h > 0;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const surface = await workspacePage.readTerminalSurface(WORKSPACE_A);
    // Guard against a vacuous pass: if this snapshot caught the surface
    // mid-relayout with zero canvases, the `for` loop below would make zero
    // assertions and pass silently. Assert there's a backing store to check.
    expect(surface.backing.length).toBeGreaterThan(0);
    for (const backing of surface.backing) {
      expect(Math.abs(backing.w - surface.screen.w * surface.dpr)).toBeLessThanOrEqual(2);
      expect(Math.abs(backing.h - surface.screen.h * surface.dpr)).toBeLessThanOrEqual(2);
    }
  });
});
