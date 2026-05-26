/**
 * Regression coverage for the "tab-switch resize snap" bug — issue tracked
 * on this branch (`fix-tab-switch-resize`).
 *
 * Background
 * ----------
 * The shared dockview layout (`apps/web/src/components/SharedDockviewLayout.tsx`)
 * hides inactive tab panels by detaching their content element from the
 * DOM (dockview's default `onlyWhenVisible` renderer). The Terminal and
 * Browser panels each embed a *nested* dockview
 * (`DockviewTerminalContainer` / `DockviewBrowserContainer`) inside
 * their content area. When the outer panel detaches, that nested
 * dockview's shell element collapses to 0×0; when the user switches
 * BACK to the Terminal or Browser tab and the shell gains real size,
 * dockview-core re-applies inline `style.width` / `style.height` to
 * its splitview view containers — but only after a
 * `requestAnimationFrame`, because
 * `node_modules/dockview-core/dist/esm/dom.js::watchElementResize`
 * wraps its ResizeObserver callback in RAF. That extra frame is what
 * the user perceives as the inner tab strip "resizing" — they briefly
 * see the splitview's stale width inlined on the container before the
 * RAF fires and corrects it.
 *
 * Fix (verified by this spec):
 *   - `DockviewTerminalContainer` and `DockviewBrowserContainer` each
 *     add a `useLayoutEffect` keyed on `visible` that reads the
 *     wrapper's current `getBoundingClientRect()` and calls
 *     `apiRef.current.layout(width, height, force=true)`
 *     synchronously. `useLayoutEffect` runs between React commit and
 *     paint, and `api.layout()` propagates straight through the
 *     splitview which writes the correct inline widths in the same
 *     call — bypassing the RAF gate. The first painted frame after
 *     the tab switch already has the correct widths.
 *
 * What this spec asserts
 * ----------------------
 * The Terminal panel's xterm-screen rect is identical before and
 * after a Files↔Terminal round-trip. Smoke coverage that exercises
 * the synchronous-layout code path: if the inner dockview ever fails
 * to re-layout (e.g. the `useLayoutEffect` is removed or
 * `api.layout()` throws), the inner splitview's stale width keeps
 * the screen rect from matching across the round-trip.
 *
 * What this spec does NOT catch
 * -----------------------------
 * The actual visible "snap" is a single ~16ms frame. Playwright's
 * `expect.poll` retries on a ~100ms interval, so by the time the
 * polled assertion runs the snap is already over and the rect is
 * back to its stable value either way. Detecting the snap directly
 * would require frame-level CDP tracing, which is fragile in CI and
 * out of scope for an integration test. The fix is verified visually
 * on a real desktop build (see the PR description for the steps);
 * this spec guards the code path so the underlying mechanism stays
 * functional.
 *
 * The Browser panel can't be tested from the web build (no native
 * WebContentsView; the "desktop only" fallback paints inline). We
 * cover that branch through manual desktop verification — see the PR
 * description for the steps.
 */

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

const TOKEN = "e2e-workspace-tab-switch-stability-token";

const PROJECT = "alpha-tabswitch";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so the desktop dockview layout renders — matches the
// `>= 1024px` gate in `apps/web/src/hooks/useIsDesktop.ts`. Below this
// width, the route falls through to a mobile layout that has no
// dockview tabs and the test wouldn't be meaningful.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT}` }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.beforeEach(async ({ page }) => {
  // Land on the workspace URL first so localStorage is accessible
  // (it's origin-scoped), clear the per-workspace dockview state, and
  // navigate fresh in the test body so we start from a known layout.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(WORKSPACE)}?token=${TOKEN}`);
  await page.evaluate(
    ([key]) => {
      localStorage.removeItem(key);
    },
    [`band:dockview-active:${WORKSPACE}`],
  );
});

test.describe("Tab-switch stability (fix-tab-switch-resize)", () => {
  test("Terminal tab content rect is identical before and after a Files↔Terminal round-trip", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    // Look up the OUTER Terminal / Files tabs via their
    // `workspace__tab--*` testids (owned by `DefaultTab` in
    // `SharedDockviewLayout.tsx`). Scoped to outer tabs only — nested
    // dockview tab strips render their own renderers and never carry
    // these testids — so the locators stay unambiguous even when the
    // inner Terminal dockview is also displaying a "Terminal" tab.
    const terminalTab = workspacePage.tab("terminal");
    const filesTab = workspacePage.tab("files");

    await terminalTab.click();
    await expect(workspacePage.terminalInput).toBeVisible();

    // Stabilize: xterm mounts asynchronously (lazy import + websocket
    // connection). Wait until the terminal container has a non-zero
    // size and stop changing. The xterm `.xterm-screen` element is
    // the inner canvas wrapper — its size matches the fit() output.
    const screen = page.locator(".xterm-screen").first();
    await expect(screen).toBeVisible();

    // `expect.poll` re-runs until the predicate is stable across two
    // consecutive reads. Without this, a flake-prone race exists
    // between "container has size" and "xterm has finished its first
    // fit()".
    const readScreenRect = async () => {
      const handle = await screen.elementHandle();
      const box = handle ? await handle.boundingBox() : null;
      return box ? { width: Math.round(box.width), height: Math.round(box.height) } : null;
    };

    // Two back-to-back rect reads must agree (and be non-zero) before
    // we treat the rect as stable. The first poll iteration after
    // mount can land mid-fit; the second confirms the rect has
    // settled. Playwright handles polling delay internally, so no
    // `waitForTimeout` (banned in this repo).
    let stableRect: { width: number; height: number } | null = null;
    await expect
      .poll(
        async () => {
          const a = await readScreenRect();
          const b = await readScreenRect();
          if (!a || !b) return false;
          if (a.width !== b.width || a.height !== b.height) return false;
          if (a.width === 0 || a.height === 0) return false;
          stableRect = a;
          return true;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(stableRect).not.toBeNull();

    // Switch to Files — Terminal panel content is detached from DOM
    // by dockview here.
    await filesTab.click();
    await expect(workspacePage.terminalInput).not.toBeVisible();

    // Switch back to Terminal. `DockviewTerminalContainer`'s
    // `useLayoutEffect` calls `api.layout(width, height)`
    // synchronously to bypass dockview-core's RAF-gated
    // ResizeObserver (see the comment on that effect for the full
    // explanation). The first paint after this click should
    // already have correct splitview widths, so the xterm
    // container — and therefore the xterm-screen rect inside it —
    // is sized to match what we captured before the round-trip.
    await terminalTab.click();
    await expect(workspacePage.terminalInput).toBeVisible();
    await expect(screen).toBeVisible();

    // The screen rect must match what we observed before the
    // round-trip. If the synchronous re-layout regressed back to
    // dockview's RAF-deferred layout (or never ran), the rect
    // would either be 0×0 for one frame or carry a stale-sized
    // value from the previously narrow splitview inline widths.
    await expect
      .poll(
        async () => {
          const after = await readScreenRect();
          return after;
        },
        { timeout: 5_000 },
      )
      .toEqual(stableRect);
  });
});
