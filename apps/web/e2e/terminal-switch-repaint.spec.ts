/**
 * Regression coverage for band-app/band#615 — "terminal renders garbled on a
 * plain workspace switch; a manual resize fixes it".
 *
 * The bug
 * -------
 * A terminal that took its FIRST paint while VISIBLE has a known-good WebGL
 * surface. But once its workspace is switched away, the `MultiWorkspacePanelHost`
 * LRU keeps it mounted under `content-visibility: hidden` — the browser skips
 * layout + paint for the subtree, which can drop the WebGL backing store or
 * leave the rendered glyphs stale. On switching BACK, the old become-visible
 * effect took the cheap branch (a bare `fitAddon.fit()`), because
 * `firstVisiblePaintDoneRef` was already `true` from the visible first paint and
 * no zoom/DPR event had re-armed the one-shot repair. `fit()` early-returns when
 * the now-visible container resolves to the SAME cols/rows it computed while
 * hidden — no reflow, no renderer repaint — so the garbled frame stayed on
 * screen until a manual window resize changed the dimensions.
 *
 * The fix (`TerminalPanel.tsx`)
 * -----------------------------
 * The one-shot `firstVisiblePaintDoneRef` gate is dropped: become-visible now
 * ALWAYS re-measures cell geometry and re-attaches the WebGL addon (dispose the
 * suspect surface, size a fresh <canvas> against the live layout) — the same
 * recovery the DPR/zoom paths use — then forces an unconditional `refresh()`.
 *
 * How this test discriminates old vs new code
 * -------------------------------------------
 * The visible garble is a GPU-pixel artifact not reproducible in headless
 * Chromium (see the sibling `terminal-background-repaint.spec.ts` for the
 * empirical reasons), so we observe the surface REBUILD instead — the exact
 * action that repairs the corruption in production. Tag the canvases of A's
 * visible-first-paint surface while A is hidden, switch back to A, and assert
 * the tags are gone (a brand-new backing store). Pre-fix code took the bare
 * `fit()` branch and left the tagged canvases in place, so this fails before the
 * fix and passes after.
 *
 * Crucial precondition vs the sibling specs
 * -----------------------------------------
 *  - `terminal-background-repaint.spec.ts`: A's FIRST paint happens while
 *    hidden, so the (old) first-paint-while-hidden repair applies.
 *  - `terminal-zoom-hidden-repaint.spec.ts`: A first paints visible, then a
 *    zoom event while hidden re-arms the (old) one-shot repair.
 *  - THIS spec: A first paints visible AND there is NO zoom — a plain
 *    hide→show. Pre-fix, NOTHING re-armed the one-shot repair, so it never
 *    rebuilt the surface. This is the gap #615 reported and the fix closes.
 *
 * Doctrine notes
 * --------------
 *  - Real production server (`startServer`), real PTYs (the two projects are
 *    `git init`-ed real dirs so they classify as "git", which renders the
 *    sidebar cards `switchWorkspace` needs and gives the PTY a real cwd).
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

const TOKEN = "e2e-terminal-switch-repaint-token";

const PROJECT_A = "alpha-switch-repaint";
const PROJECT_B = "bravo-switch-repaint";
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

// Definite-assignment: all four are set in `beforeAll`. The `!` lets `afterAll`
// reference them while still guarding `server` (the only one that can be left
// unassigned if `startServer` throws mid-boot).
let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
let workdirB!: string;

/** Hermetic git environment: an explicit allowlist (no `process.env` spread)
 *  with `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at /dev/null so a
 *  contributor's host git config can't leak in and hang or skew the setup.
 *  Mirrors `terminal-zoom-hidden-repaint.spec.ts`. */
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
  workdirA = makeGitWorkdir("band-switch-repaint-a-", tmpHome);
  workdirB = makeGitWorkdir("band-switch-repaint-b-", tmpHome);
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

test.describe("Terminal repaint on plain workspace switch", () => {
  test("switching back to a cached workspace rebuilds its terminal's WebGL surface without a manual resize", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Land on A and open its Terminal tab WHILE A IS ACTIVE/VISIBLE. This is
    // the discriminating precondition: A's terminal takes its first paint
    // visible, so the (old) first-paint-while-hidden repair does NOT apply.
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
    // Confirm B is actually active/visible AND A is hidden before we tag — a
    // sidebar click can land on B's route before B's panels finish rendering,
    // and we don't want to tag while the layout is still settling.
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, false)).toBeAttached({
      timeout: 20_000,
    });

    // Tag the canvases of A's (visible-first-paint) surface while it's hidden.
    // NO zoom / DPR event fires in this scenario — that's the whole point: the
    // pre-fix one-shot repair had nothing to re-arm it.
    const tagged = await workspacePage.tagTerminalCanvases(WORKSPACE_A);
    expect(tagged).toBeGreaterThan(0);

    // Bring A back to the foreground and re-activate its Terminal tab so A's
    // terminal flips hidden → visible — the become-visible transition the fix
    // hooks. This is a plain workspace switch: no resize, no zoom.
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });

    // The discriminating assertion: with the fix, become-visible ALWAYS
    // disposes the surface built/held while hidden and re-attaches a fresh
    // WebGL addon — none of the tagged canvases survive. Pre-fix, the one-shot
    // repair stayed "done" (nothing re-armed it), so become-visible only
    // called `fit()` (resizing the SAME canvases at most) and the tags would
    // survive → this poll times out → the test fails before the fix.
    //
    // Require `canvasCount > 0` in the same poll: mid-rebuild there is a window
    // where the old surface has been disposed and the fresh one not yet
    // attached, during which `survivingTags` is trivially 0 with no canvas
    // present. Pairing the conditions ensures we only accept a 0 that means "a
    // real surface exists and none of it is tagged", never a vacuous 0.
    await expect
      .poll(
        async () => {
          const s = await workspacePage.readTerminalSurface(WORKSPACE_A);
          return s.canvasCount > 0 && s.survivingTags === 0;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

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
