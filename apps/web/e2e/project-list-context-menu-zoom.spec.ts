/**
 * Regression coverage for two distinct zoom bugs in the project-list
 * context menu. Real server boot, Page Object Model, no mocking.
 *
 * Bug 1 — menu disappears on right-button release. At non-100% zoom,
 * right-clicking a project header makes the context menu appear and
 * immediately vanish: the first item ("Add workspace" for a git project)
 * fires as if clicked, even though the user only released the right
 * mouse button. `@radix-ui/react-menu`'s `MenuItem` synthesises a
 * `click()` whenever a `pointerup` arrives on an item without a matching
 * prior `pointerdown` on the same item (a "drag from outside, release on
 * item" heuristic). The right-click open sequence (pointerdown on
 * trigger → contextmenu opens menu → pointerup at cursor) matches it: at
 * 100% zoom the popper offset keeps the first item ~7 CSS px right of the
 * cursor so pointerup misses the menu, but at other zoom levels sub-pixel
 * rounding puts the cursor inside the item and the heuristic fires. Fix:
 * the shared `ContextMenuContent` swallows non-left-button pointer events
 * in the capture phase so they never reach item handlers.
 *
 * Bug 2 — menu mispositioned under app zoom. The dashboard zooms the
 * whole UI via CSS `zoom` on `<html>` (mirrored onto the `--app-zoom`
 * variable). Floating UI anchors the popper wrapper (a `position: fixed`
 * child of `<body>`) at the pointer's clientX/clientY in *visual* px, but
 * the CSS `zoom` then scales that translate again, landing every popper at
 * clientXY × zoom. Fix: a global counter-scale stylesheet rule keyed on
 * `--app-zoom` cancels the doubled scaling.
 *
 * Architecture (mirrors the rest of the e2e suite):
 *   - The real production binary runs against a fresh tmp `~/.band/`.
 *   - One git-kind project is seeded directly into SQLite. The
 *     `git worktree list` background poller fails gracefully because the
 *     paths don't exist on disk, but the sidebar still renders — the
 *     context-menu trigger lives entirely in the React tree.
 *   - Zoom is applied via the `WorkspacePage` zoom helpers:
 *     `applyBodyZoom` (legacy body-level path for bug 1) and
 *     `applyAppZoom` (the production `<html>` + `--app-zoom` path for
 *     bug 2).
 *   - The dashboard sidebar mounts on the workspace route; we land
 *     there with the seeded project's `main` workspace.
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

const TOKEN = "e2e-context-menu-zoom-token";

const PROJECT = "zoom-ctx-menu-project";
const BRANCH = "feature-zoom-ctx";
const WORKSPACE_ID = toWorkspaceId(PROJECT, BRANCH);

// Wide viewport so the desktop layout — and therefore the sidebar project
// list — is the one that mounts. Matches the `>= 1024px` desktop cutoff.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // A git-kind project (worktree count > 0 with a non-default branch) so
  // the rendered SortableProject takes the git branch — the one that owns
  // the failing context menu, whose first item is "Add workspace". Two
  // worktrees keep the "Add workspace" and "Delete workspace" affordances
  // meaningful.
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: `/tmp/fake/${PROJECT}` },
          { branch: BRANCH, path: `/tmp/fake/${PROJECT}-${BRANCH}` },
        ],
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

test.describe("Project list context menu — zoom regression", () => {
  // 1.5 is the smallest zoom level that reliably reproduces the bug on a
  // 96 dpi virtual display: at 1.25 the cursor still lands on the
  // 1px border + 4px padding gutter, but at 1.5 the sub-pixel rounding
  // shifts the gutter and the cursor falls inside the first menu item.
  // Larger zooms (2.0, 3.0) also reproduce, but 1.5 keeps the layout
  // recognisable in the screenshot if a future regression debug session
  // needs it.
  const ZOOM_FACTOR = 1.5;

  test("right-button pointerup on a menu item does NOT activate it", async ({ page }) => {
    // Reproduces the exact event sequence the disappearing-menu bug
    // exploits without depending on Playwright laying the menu out under
    // the cursor (which body zoom doesn't quite reproduce — Floating
    // UI's sub-pixel math differs under the CSS `zoom` property vs
    // Electron's `setZoomFactor`). The mechanism the bug relies on is:
    //
    //   1. `pointerdown (button=2)` fires on the trigger.
    //   2. `contextmenu` opens the menu; the first item mounts.
    //   3. `pointerup (button=2)` fires on the freshly-mounted item.
    //   4. Radix `MenuItem` sees `pointerup` with no prior `pointerdown`
    //      on the same item, calls `.click()`, and the item activates.
    //
    // We skip step 3's coordinate gymnastics and dispatch the
    // `pointerup` directly on the first item with button=2 — exactly what
    // happens to the bug-affected user. Before the fix the item activates
    // and the menu closes; after the fix the capture-phase filter
    // swallows it and the menu stays open.
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_ID);
    await workspacePage.waitForReady();

    await expect(workspacePage.projectHeader(PROJECT)).toBeVisible();
    await workspacePage.openProjectContextMenu(PROJECT);

    // Confirm the menu actually mounted before driving pointer events.
    await expect(workspacePage.addWorkspaceMenuItem).toBeVisible();

    await workspacePage.dispatchRightButtonPointerUpOnAddWorkspaceItem();

    // Assertion 1 — the menu MUST still be open after the right-button
    // pointerup. Before the fix, Radix calls `.click()` on the item, the
    // `onClick` handler runs, and the menu closes.
    await expect(workspacePage.contextMenu).toBeVisible();
    await expect(workspacePage.addWorkspaceMenuItem).toBeVisible();

    // Assertion 2 — the "Add workspace" action must NOT have fired. Its
    // observable side effect is opening the New Workspace dialog; if the
    // item had been triggered, that dialog would be present. The still-open
    // menu asserted above is the positive anchor for this negative check.
    await expect(workspacePage.newWorkspaceDialog).not.toBeVisible();
  });

  test("right-click stays open at 150% browser zoom", async ({ page }) => {
    // End-to-end approximation of the zoom scenario: apply browser zoom,
    // right-click via real mouse events, and assert the menu stays open.
    // Body zoom doesn't reproduce Electron's `setZoomFactor` sub-pixel
    // math exactly, so this test's assertions are weaker than the
    // direct-dispatch test above — but it guards against regressions in
    // the trigger setup (the `data-testid` on the project header, the
    // `ContextMenu` wiring, etc.) that the direct-dispatch test wouldn't
    // catch.
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_ID);
    await workspacePage.waitForReady();

    await workspacePage.applyBodyZoom(ZOOM_FACTOR);

    await expect(workspacePage.projectHeader(PROJECT)).toBeVisible();
    await workspacePage.openProjectContextMenu(PROJECT);

    await expect(workspacePage.contextMenu).toBeVisible();
    await expect(workspacePage.addWorkspaceMenuItem).toBeVisible();
  });

  test("context menu anchors at the cursor at 150% app zoom", async ({ page }) => {
    // Positioning regression (bug 2, distinct from the disappearing-menu
    // bug above). We set CSS `zoom` on `<html>` plus `--app-zoom` exactly
    // as production does (the pre-paint init script seeds both),
    // then assert the opened menu's top-left lands within a few px of the
    // coordinates the `contextmenu` event actually reported. Pre-fix, at
    // 1.5× the menu is ~100px / ~67px off — far outside the tolerance.
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_ID);
    await workspacePage.waitForReady();

    await workspacePage.applyAppZoom(ZOOM_FACTOR);

    const { cursor, menu } = await workspacePage.openProjectContextMenuAndMeasureAnchor(PROJECT);

    // The menu's top edge aligns with the cursor's Y essentially exactly
    // (≈0px off when fixed), while its left edge sits within a small
    // placement offset of the cursor's X (≈0–6px). Both tolerances stay
    // well below the pre-fix error (≈67px Y / ≈100px X at 1.5×). The Y
    // band is kept tight so a future regression that nudges the vertical
    // anchor still trips it.
    expect(Math.abs(menu.top - cursor.y)).toBeLessThan(10);
    expect(Math.abs(menu.left - cursor.x)).toBeLessThan(30);
  });

  test("right-click stays open at 100% zoom (baseline — pre-fix behaviour is already correct here)", async ({
    page,
  }) => {
    // Baseline / sanity test: at 100% zoom the bug doesn't manifest even
    // without the fix. This guards against a regression that would break
    // the NON-zoomed case too — if a future change makes
    // `ContextMenuContent` swallow LEFT-button events as well, this test
    // catches it because it both opens the menu (right-click) and
    // exercises a left-click on an item.
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_ID);
    await workspacePage.waitForReady();

    await expect(workspacePage.projectHeader(PROJECT)).toBeVisible();
    await workspacePage.openProjectContextMenu(PROJECT);

    await expect(workspacePage.contextMenu).toBeVisible();

    // Left-clicking the first item ("Add workspace") must still activate it
    // — proving the capture-phase filter is button-selective (left clicks
    // pass through; only non-left pointer events are swallowed).
    await workspacePage.clickAddWorkspaceMenuItem();
    await expect(workspacePage.contextMenu).not.toBeVisible();
    // Positive anchor: the action fired, so its New Workspace dialog rendered.
    await expect(workspacePage.newWorkspaceDialog).toBeVisible();
  });

  test("the header ⋮ button opens the project action menu and can add a workspace", async ({
    page,
  }) => {
    // The kebab is a left-click opener for the same action list as the
    // right-click context menu — the discoverable path (and the only one on
    // touch, where there's no right-click). Prove it opens the menu and that
    // "Add workspace" is wired to the New Workspace dialog.
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_ID);
    await workspacePage.waitForReady();

    await expect(workspacePage.projectHeader(PROJECT)).toBeVisible();
    await workspacePage.openProjectMenuViaKebab(PROJECT);

    await expect(workspacePage.contextMenu).toBeVisible();
    await expect(workspacePage.addWorkspaceMenuItem).toBeVisible();

    await workspacePage.clickAddWorkspaceMenuItem();
    // Prove the dropdown dismissed before asserting the dialog opened.
    await expect(workspacePage.contextMenu).not.toBeVisible();
    await expect(workspacePage.newWorkspaceDialog).toBeVisible();
  });
});
