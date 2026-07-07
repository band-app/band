/**
 * Regression coverage for the maximize-restore "ghost panel" (a regression
 * in #490's restore-maximized-panel-on-refocus flow) after a CLIENT-SIDE
 * workspace switch back into a workspace with a maximized inner-dockview
 * group. Covered for both inner containers that received the fix:
 * Terminal and Browser.
 *
 * Repro (user report, terminal variant):
 *   1. Workspace A: activate the Terminal tab and maximize its group.
 *   2. Sidebar-click to workspace B (split layout, no maximize).
 *   3. Sidebar-click back to A.
 *
 * The outer dockview re-applied A's maximize correctly (Restore button
 * visible, group header full-width), but the INNER terminal dockview kept
 * the split-width inline sizes: `DockviewTerminalContainer`'s
 * `useLayoutEffect([visible])` measures its container synchronously on the
 * switch commit — while the outer grid is still in B's split — and calls
 * `api.layout(splitWidth)`. `SharedDockviewLayout`'s switch effect
 * re-applies the maximize only afterwards, and because the transient split
 * width never reached a rendered frame, dockview-core's stale-comparing
 * `watchElementResize` never fired — leaving the terminal content at half
 * width with a blank "ghost" region on the right.
 *
 * `DockviewBrowserContainer` received the identical fix, but it mounts only
 * in the Electron desktop shell (`SharedDockviewLayout`'s
 * `BrowserPanelComponent` renders a "desktop only" placeholder — or the
 * ScreencastPanel experiment — on the web build), so the browser variant
 * has no web-observable surface for this Playwright suite to drive. The
 * terminal journey below exercises the shared effect logic.
 *
 * The sibling `workspace-maximize-state.spec.ts` covers the same journey
 * through hard navigations (`page.goto`), which remounts the whole React
 * tree and never hits this path — hence the dedicated client-side-switch
 * spec. Assertions are geometric (toolbar right-edge gap) because the bug
 * is a layout artifact invisible to state/DOM-presence probes: the
 * persisted state and Restore button were already correct while the ghost
 * rendered.
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

const TOKEN = "e2e-workspace-maximize-ghost-panel-token";

const PROJECT_A = "alpha-ghost";
const PROJECT_B = "bravo-ghost";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (and therefore the maximize button) renders.
test.use({ viewport: { width: 1280, height: 800 } });

// The inner container's toolbar is right-aligned in the inner dockview's
// group header, a few px of padding from its right edge. When the maximize
// is correctly applied the gap to the viewport's right edge is that padding
// (~20 px); with the ghost bug the inner dockview is stuck at the previous
// workspace's split width, putting the gap at roughly half the grid
// (500+ px on this viewport). 100 px separates the two regimes with margin
// on both sides.
const MAX_TOOLBAR_RIGHT_GAP_PX = 100;

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [PROJECT_A, PROJECT_B].map((name) => ({
      name,
      path: `/tmp/fake/${name}`,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: `/tmp/fake/${name}` }],
    })),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Workspace maximize ghost panel (#490 maximize-restore regression)", () => {
  test("client-side switch back into a maximized workspace re-lays the inner terminal dockview to the full maximized width", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Workspace A: bring the Terminal tab forward and maximize its group
    // (index 1 — the right group of the default layout; index 0 is chat).
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.activateTab("terminal");
    await workspacePage.maximizePanel(1);
    await expect(workspacePage.restoreButton).toBeVisible();

    // Positive anchor for the geometry probe: with the group maximized,
    // the inner terminal toolbar must already hug the viewport's right
    // edge. Also proves the probe measures what we think it measures.
    await expect
      .poll(() => workspacePage.readToolbarRightGap(WORKSPACE_A, "terminal"))
      .toBeLessThan(MAX_TOOLBAR_RIGHT_GAP_PX);

    // Client-side switch to B via the sidebar card — NOT a `goto`. A hard
    // navigation remounts the React tree and takes the onReady restore
    // path, which never had this bug; the sidebar click keeps A's panels
    // cached and drives the workspace-switch effect under test.
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.maximizeButtons.first()).toBeVisible();
    await expect(workspacePage.restoreButton).not.toBeVisible();

    // Back to A the same way. The maximize must be re-applied…
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await expect(workspacePage.restoreButton).toBeVisible();

    // …and the inner terminal dockview must be re-laid to the maximized
    // width: no half-width tab strip, no blank ghost region on the right.
    await expect
      .poll(() => workspacePage.readToolbarRightGap(WORKSPACE_A, "terminal"))
      .toBeLessThan(MAX_TOOLBAR_RIGHT_GAP_PX);
  });
});
