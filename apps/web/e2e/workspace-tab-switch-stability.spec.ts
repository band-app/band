/**
 * Regression coverage for the "tab-switch resize snap" bug — issue tracked
 * on this branch (`fix-tab-switch-resize`).
 *
 * Background
 * ----------
 * The shared dockview layout (`apps/web/src/components/SharedDockviewLayout.tsx`)
 * hides inactive tab panels by detaching their content element from the
 * DOM (dockview's default `onlyWhenVisible` renderer). When the user
 * switches BACK to the Terminal or Browser tab, two non-DOM rendering
 * surfaces have to catch up to the panel's real size:
 *
 *   - Terminal: xterm.js's canvas has internal pixel dimensions
 *     driven by `fitAddon.fit()`. Before the fix, that fit was queued
 *     via `requestAnimationFrame`, so the browser painted ONE frame
 *     with the still-old-sized canvas, then ANOTHER frame after the
 *     RAF resized it — the user saw the second-frame "snap".
 *   - Browser (desktop only): the native WebContentsView is an
 *     OS-level overlay positioned over IPC. Before the fix, the
 *     visibility effect awaited `browser_show` and THEN awaited
 *     `browser_set_bounds`, so the view re-appeared at its stale
 *     last-known rect before snapping to the placeholder's current
 *     rect.
 *
 * Fix (verified by this spec):
 *   - `TerminalPanel.tsx` now uses `useLayoutEffect` with a
 *     synchronous `fitAddon.fit()` call (no RAF), so the canvas
 *     resize lands in the same commit phase as the visibility flip
 *     and the very first paint after the tab switch already has
 *     the right-sized canvas.
 *   - `BrowserPanel.tsx` fires `browser_set_bounds` BEFORE
 *     `browser_show` (no inter-await) and elevates the workspace-
 *     level visibility effect to `useLayoutEffect`.
 *
 * What this spec asserts
 * ----------------------
 * The Terminal panel's xterm-screen rect is identical before and
 * after a Files↔Terminal round-trip. This is functional smoke
 * coverage for the new `useLayoutEffect` code path — if the
 * synchronous fit() throws, or somehow ends up sizing the canvas to
 * a different rect than the previous mount, this spec fails.
 *
 * What this spec does NOT catch
 * -----------------------------
 * The actual visible "snap" is a single ~16ms frame. Playwright's
 * `expect.poll` retries on a ~100ms interval, so by the time the
 * polled assertion runs the snap is already over and the canvas is
 * back to a correct rect. Detecting the snap directly would require
 * frame-level CDP tracing, which is fragile in CI and out of scope
 * for an integration test. The fix is verified visually on a real
 * machine (see the PR description) and this spec guards the code
 * path so the underlying mechanism stays functional.
 *
 * The Browser panel can't be tested from the web build (no native
 * WebContentsView; the "desktop only" fallback paints inline). We
 * cover that branch through manual desktop verification — see the PR
 * description for the steps.
 */

import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
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
  rmSync(tmpHome, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  // Land on the workspace URL first so localStorage is accessible
  // (it's origin-scoped), clear the per-workspace dockview state, and
  // navigate fresh in the test body so we start from a known layout.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(WORKSPACE)}/code?token=${TOKEN}`);
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

    // Find the Terminal and Files dockview tabs. Dockview labels its
    // tab elements with `.dv-default-tab` and the tab text matches
    // the panel title. `getByRole("tab")` would be cleaner but
    // dockview's default tab markup doesn't add `role="tab"` — the
    // `.dv-default-tab` content div is what receives the click.
    const terminalTab = page.locator(".dv-default-tab", { hasText: "Terminal" }).first();
    const filesTab = page.locator(".dv-default-tab", { hasText: "Files" }).first();

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

    // Switch back to Terminal. The visibility-change handler runs
    // `fitAddon.fit()` synchronously inside `useLayoutEffect`; the
    // first paint after this click should already show the
    // correctly-sized xterm canvas.
    await terminalTab.click();
    await expect(workspacePage.terminalInput).toBeVisible();
    await expect(screen).toBeVisible();

    // The screen rect must match what we observed before the
    // round-trip. If the synchronous fit regressed back to a RAF (or
    // worse, never fired), the rect would either be 0×0 for one
    // frame or a stale-sized value.
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
