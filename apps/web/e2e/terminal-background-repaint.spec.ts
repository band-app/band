/**
 * Regression coverage for the "terminal renders garbled until you resize the
 * window" bug (branch `fix/terminal-garbled-until-resize`).
 *
 * The bug
 * -------
 * A terminal whose FIRST paint happens while its workspace is a hidden
 * background tab (kept mounted by the `MultiWorkspacePanelHost` LRU cache
 * under `content-visibility: hidden` / `visibility: hidden`) establishes its
 * WebGL render surface against a hidden / degenerate layout. When the
 * workspace later becomes visible, the old "became visible" effect only
 * called `fitAddon.fit()`. If the now-visible container resolves to the SAME
 * cols/rows `fit()` already computed while hidden, xterm's `resize()`
 * early-returns — no reflow, no renderer repaint — so the surface built
 * against the hidden layout stays on screen, garbled, until a manual window
 * resize changes the dimensions and forces a real reflow.
 *
 * The fix (`TerminalPanel.tsx`)
 * -----------------------------
 * On become-visible we now re-measure cell geometry and **re-attach the
 * WebGL addon** (dispose the surface built while hidden, size a fresh
 * <canvas> against the live layout) instead of relying on `fit()` alone —
 * the same recovery the DPR / zoom paths already use. A fresh surface
 * repaints every cell from scratch regardless of whether cols/rows changed.
 *
 * Why this test observes the surface REBUILD, not pixels
 * ------------------------------------------------------
 * The visible garble is a GPU-pixel artifact. It is NOT reproducible in
 * headless Chromium for two independent reasons, both confirmed empirically
 * while writing this test:
 *
 *   1. xterm measures cell geometry from FONT metrics, which are
 *      layout-independent — so even a terminal that boots under
 *      `content-visibility: hidden` gets a *valid* default-sized surface
 *      (80x24), never a pixel-mangled one.
 *   2. Whenever the hidden and visible layouts differ, `fit()` changes
 *      cols/rows on become-visible and xterm resizes the surface anyway, so
 *      the old code "self-heals" in the cases headless can construct.
 *
 * The single behaviour that DOES differ between the old and new code in
 * every case — and the exact action that repairs the corruption in
 * production — is the surface rebuild: the fix disposes the
 * established-while-hidden <canvas> and attaches a new one. We make that
 * observable by tagging the hidden surface's canvases, switching the
 * workspace to the foreground, and asserting the tags are gone (a brand-new
 * backing store) AND the rebuilt surface is correctly sized to the visible
 * container. The old code leaves the tagged canvases in place (resized at
 * most), so this fails before the fix and passes after.
 *
 * Doctrine notes
 * --------------
 *  - Real production server (`startServer`), real PTYs (the two projects are
 *    `git init`-ed real dirs so they classify as "git" — which both renders
 *    the sidebar workspace cards `switchWorkspace` needs AND gives the PTY a
 *    real cwd to spawn in).
 *  - No tRPC mocking, no `page.route` on our own routes. The only external-
 *    boundary control is the Chromium launch flags that turn on SwiftShader
 *    WebGL so the headless renderer matches production's WebGL default.
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

const TOKEN = "e2e-terminal-bg-repaint-token";

const PROJECT_A = "alpha-bg-repaint";
const PROJECT_B = "bravo-bg-repaint";
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

let server: ServerHandle;
let tmpHome: string;
let workdirA: string;
let workdirB: string;

/** Hermetic git environment: an explicit allowlist (no `process.env`
 *  spread) with `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at
 *  /dev/null so a contributor's host git config (templates, signing-key
 *  prompts, hooks) can't leak in and hang or skew the setup. Mirrors the
 *  pattern in `workspace-cache-eviction.spec.ts`. */
function makeGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
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
 *
 *  `init -b main` forces the initial branch name: without it, a host (or CI
 *  runner) whose git defaults to `master` would make the worktree-sync
 *  poller rewrite the seeded `main` worktree to `master`, and the
 *  `--<project>-main` card testid the test clicks would never appear. */
function makeGitWorkdir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env = makeGitEnv();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdirA = makeGitWorkdir("band-bg-repaint-a-");
  workdirB = makeGitWorkdir("band-bg-repaint-b-");
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
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(workdirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(workdirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal background-workspace first paint", () => {
  test("a terminal that first paints in a hidden background workspace rebuilds its WebGL surface when it becomes visible", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Land on A (active), then switch to B via the sidebar so A stays MOUNTED
    // in the LRU cache but inactive (`wsActive=false`). In-app navigation
    // (sidebar click), not `goto()`, is what keeps A cached — a full
    // navigation would tear the cache down.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.switchWorkspace(WORKSPACE_B);

    // Activate the outer Terminal tab. The shared outer dockview means BOTH
    // cached workspaces' terminal containers now mount: B's mounts visible,
    // A's mounts while A's host is `content-visibility: hidden` — i.e. A's
    // terminal takes its FIRST paint while hidden, which is the bug's
    // precondition.
    await workspacePage.openTerminalTab();

    // Positive anchors: B's terminal observed visible, A's observed hidden.
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, false)).toBeAttached({
      timeout: 20_000,
    });

    // Wait for A's hidden terminal to attach its WebGL surface. This also
    // asserts the WebGL precondition: if SwiftShader weren't available the
    // addon would fall back to the DOM renderer, no <canvas> would exist, and
    // this poll would (correctly) fail loudly rather than the test passing
    // vacuously.
    await expect
      .poll(async () => (await workspacePage.readTerminalSurface(WORKSPACE_A)).canvasCount, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    // Tag the canvases that make up A's established-while-hidden surface.
    const tagged = await workspacePage.tagTerminalCanvases(WORKSPACE_A);
    expect(tagged).toBeGreaterThan(0);

    // Bring A to the foreground and re-activate its Terminal tab so A's
    // terminal flips from hidden → visible (A's restored layout may show a
    // different outer tab). This is the become-visible transition the fix
    // hooks.
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });

    // The discriminating assertion: on become-visible the fix disposes the
    // surface built while hidden and re-attaches a fresh WebGL addon, so none
    // of the tagged canvases survive. The pre-fix code only called `fit()`
    // (resizing the SAME canvases in place at most), so its tags would
    // survive and this poll would time out → the test fails before the fix.
    await expect
      .poll(async () => (await workspacePage.readTerminalSurface(WORKSPACE_A)).survivingTags, {
        timeout: 20_000,
      })
      .toBe(0);

    // Positive correctness anchor: the rebuilt surface is sized to the
    // now-visible container — its WebGL backing store matches the
    // `.xterm-screen` rect (× devicePixelRatio). This is the user-observable
    // "the terminal grid matches the visible container size" guarantee; a
    // surface left sized to the hidden layout would mismatch here.
    const surface = await workspacePage.readTerminalSurface(WORKSPACE_A);
    expect(surface.canvasCount).toBeGreaterThan(0);
    expect(surface.screen.w).toBeGreaterThan(0);
    expect(surface.screen.h).toBeGreaterThan(0);
    for (const backing of surface.backing) {
      expect(Math.abs(backing.w - surface.screen.w * surface.dpr)).toBeLessThanOrEqual(2);
      expect(Math.abs(backing.h - surface.screen.h * surface.dpr)).toBeLessThanOrEqual(2);
    }
  });
});
