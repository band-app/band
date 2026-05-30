/**
 * Regression coverage for issue #469 — the three Dockview inner
 * containers (Chat / Terminal / Browser) share a single
 * `PanelVisibilityContext` instead of each declaring their own.
 *
 * Background
 * ----------
 * Before #469, `DockviewChatContainer`, `DockviewTerminalContainer` and
 * `DockviewBrowserContainer` each declared their own React Context with
 * an identical `{ visible, wsActive }` shape and wrapped their inner
 * `DockviewReact` in a per-container Provider. The refactor moved the
 * context out into `panel-visibility-context.tsx` and pointed all three
 * containers at the shared `PanelVisibilityContext` + `usePanelVisibility`.
 *
 * What this spec asserts
 * ----------------------
 * The visibility signal still reaches the tab panels — i.e. each
 * container's `<PanelVisibilityContext.Provider value={…}>` is correctly
 * wired AND the leaf tab panel still calls `usePanelVisibility()`
 * inside the Provider's subtree. We assert this directly by reading a
 * `data-testid` on the tab panel's wrapper div that encodes the
 * `visible` value the context plumbed in.
 *
 * If a future change removed the Provider on any one container (or
 * pointed the hook at the wrong context), the leaf would fall back to
 * the context's default value (`{ visible: true, wsActive: true }`) and
 * the marker for a workspace cached behind another active one would
 * report `visible-true` instead of `visible-false`. The test below
 * checks exactly that case for both the chat and terminal containers.
 *
 * Why we use the LRU-cached entry as the regression lever
 * --------------------------------------------------------
 * The outer Shared Dockview's default `onlyWhenVisible` mode detaches a
 * panel's content from the DOM when its outer tab is inactive — so a
 * test that just clicks outer tabs back and forth couldn't distinguish
 * "context propagated visible=false" from "container unmounted". The
 * `MultiWorkspacePanelHost` LRU cache keeps the inactive workspace's
 * subtree MOUNTED but passes `wsActive=false` into its
 * `DockviewChatContainer` / `DockviewTerminalContainer`. The shared
 * context is the only channel that propagates that `wsActive=false`
 * down to the leaf — making it the exact regression lever this refactor
 * could break.
 *
 * Out of scope
 * ------------
 * The Browser container is only mounted in the Electron desktop build
 * (see `SharedDockviewLayout`'s `BrowserPanelComponent` web fallback).
 * The same `data-testid` marker is set on it for parity, but verifying
 * it requires desktop e2e coverage that this web-build spec can't
 * provide. The TypeScript + biome + lint pipeline catches the symbol-
 * level half of the refactor on that container; the structural half
 * (Provider wiring + hook usage) mirrors chat and terminal exactly, so
 * coverage on those two is a reasonable proxy.
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

const TOKEN = "e2e-panel-visibility-context-token";

const PROJECT_A = "alpha-visibility";
const PROJECT_B = "bravo-visibility";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders (>= 1024px in `apps/web/src/hooks/useIsDesktop.ts`). The chat
// / terminal containers under test only mount in the desktop layout.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT_A,
        path: `/tmp/fake/${PROJECT_A}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_A}` }],
      },
      {
        name: PROJECT_B,
        path: `/tmp/fake/${PROJECT_B}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_B}` }],
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
  // (origin-scoped), clear the per-workspace dockview state for both
  // workspaces, and start tests from a default layout.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(WORKSPACE_A)}?token=${TOKEN}`);
  await page.evaluate(
    ([keys]) => {
      for (const key of keys) localStorage.removeItem(key);
    },
    [[`band:dockview-active:${WORKSPACE_A}`, `band:dockview-active:${WORKSPACE_B}`]],
  );
});

test.describe("Panel visibility context (issue #469)", () => {
  test("Chat tab panel observes visible=true for the active workspace and visible=false for the cached one", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Navigate to A. The default layout puts the Chat panel in its own
    // group on the left so it's mounted and visible immediately —
    // `parentVisible` from context is `true` AND the inner default chat
    // tab is the active inner tab, so the leaf gets `visible=true`.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();

    // Positive anchor: A's active chat tab has the visible-true marker.
    // The marker is set on the inner ChatTabContent wrapper div whose
    // `visible` value is `parentVisible(true) && tabActive(true)`.
    await expect(workspacePage.chatTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible();

    // Switch to B via the sidebar card. This uses TanStack Router's
    // in-app navigation, which keeps A's panels mounted in the LRU
    // cache while flipping `wsActive` from true→false for A and
    // false→true for B. The full-page `goto()` would tear down the
    // React tree and defeat the regression lever.
    await workspacePage.switchWorkspace(WORKSPACE_B);

    // Anchor on B's visible-true marker first — proves the new
    // workspace actually rendered before we assert on A's now-hidden
    // state.
    await expect(workspacePage.chatTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible();

    // A is cached → `wsActive=false` → context value becomes
    // `{ visible: false, wsActive: false }` → leaf marker flips to
    // `visible-false`. If the shared-context refactor regressed (e.g.
    // the Provider was removed from `DockviewChatContainer`), the
    // leaf would default to `{ visible: true, wsActive: true }` and
    // A's marker would still report `visible-true` even while cached.
    await expect(workspacePage.chatTabVisibilityMarker(WORKSPACE_A, false)).toBeAttached();
    await expect(workspacePage.chatTabVisibilityMarker(WORKSPACE_A, true)).toHaveCount(0);
  });

  test("Terminal tab panel observes visible=true for the active workspace and visible=false for the cached one", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();

    // Activate the outer Terminal tab. The default layout starts with
    // Changes as the active tab in the right group; clicking Terminal
    // promotes its panel to active and mounts the
    // `DockviewTerminalContainer`. The Chat panel is in a separate
    // group on the left and stays mounted regardless.
    await workspacePage.tab("terminal").click();

    // Sanity-check A's terminal tab observed visible=true via the
    // shared context.
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible();

    // Switch to B — A becomes cached, B is now active. The outer
    // Terminal tab stays selected (the outer dockview is shared across
    // workspaces), so both A's and B's terminal containers stay
    // mounted simultaneously.
    await workspacePage.switchWorkspace(WORKSPACE_B);

    // Positive anchor on B before asserting A is hidden.
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible();

    // A's cached terminal tab must now report visible=false. The same
    // regression-lever logic as the chat test above: the only way for
    // `wsActive=false` to reach the leaf is via the shared context.
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, false)).toBeAttached();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toHaveCount(0);

    // Round-trip back to A — A becomes active, B becomes cached. The
    // direction of the visibility flip reverses, proving the context
    // tracks `wsActive` symmetrically.
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, false)).toBeAttached();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toHaveCount(0);
  });
});
