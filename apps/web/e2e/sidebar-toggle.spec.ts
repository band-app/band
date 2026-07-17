/**
 * End-to-end coverage for the project-list sidebar toggle.
 *
 * The project list now lives in a standalone left sidebar, SEPARATE from the
 * dockview (it used to be the dockview's `edge-left` "projects" panel). A
 * header button — plus the ⌘B shortcut and the ⌃0 "Focus Projects" path —
 * toggles its visibility, and the last-left state persists across reloads.
 *
 * Architecture (matches the repo's integration doctrine):
 *   - The real production binary runs against a fresh tmp `~/.band/`.
 *   - No tRPC mocking — the dashboard renders against the real backend. One
 *     project (no real worktree on disk) is seeded into SQLite so a
 *     workspace route mounts; background git calls fail gracefully but the
 *     dockview + sidebar still render.
 *   - All UI is driven through `WorkspacePage` (no raw `page.*` in the body).
 *
 * The sidebar is a collapsible resizable-panel: collapsing shrinks its width
 * to ~0 rather than unmounting the sibling panel that holds the dockview
 * (which must stay mounted so cached workspaces survive a toggle). So the
 * user-observable signal for hidden/shown is the sidebar's rendered width,
 * cross-checked against the toggle button's `aria-pressed` state.
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

const TOKEN = "e2e-sidebar-toggle-token";
const PROJECT = "alpha-sidebar";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so `useIsDesktop()` reports true and the desktop layout
// (title bar + sidebar + dockview) renders (>= 1024px in useIsDesktop.ts).
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

test("the sidebar is visible by default and the toggle button reads pressed", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
  await expect(wp.sidebarToggle).toBeVisible();
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "true");
});

test("the header button hides and shows the sidebar", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  // Hide.
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "false");

  // Show.
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "true");
});

test("the ⌘B shortcut toggles the sidebar", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  await wp.toggleSidebarViaShortcut();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "false");

  await wp.toggleSidebarViaShortcut();
  await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "true");
});

test("⌃0 (Focus Projects) reveals a collapsed sidebar", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  // Hide first, then prove ⌃0 brings it back.
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);

  await wp.focusProjectsViaShortcut();
  await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "true");
});

test("the nav cluster renders once alongside the sidebar's own action bar", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  // The nav cluster is a single stationary overlay over the title-bar row. The
  // overflow actions live in the project-list bottom action bar; there is
  // no title-bar hamburger anywhere, so the Menu button is absent.
  await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
  await expect(wp.sidebarToggle).toHaveCount(1);
  await expect(wp.actionBarWithinSidebar).toBeVisible();
  await expect(wp.menuTrigger).toHaveCount(0);
});

test("the toggle and back/forward stay put (no relocation, no jump) when the sidebar collapses", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  // Precondition: while visible, the actions live in the project-list bottom
  // action bar and there is no title-bar hamburger.
  await expect(wp.actionBarWithinSidebar).toBeVisible();
  await expect(wp.menuTrigger).toHaveCount(0);
  await expect(wp.sidebarToggle).toBeVisible();
  const xBefore = await wp.sidebarToggleX();

  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);

  // The cluster is hosted in a stationary overlay, so its controls stay reachable
  // while the list is collapsed — at the exact same position (the flicker
  // regression was the cluster remounting 3px off between the two bars)...
  await expect(wp.sidebarToggle).toBeVisible();
  await expect(wp.backButton).toBeVisible();
  await expect(wp.forwardButton).toBeVisible();
  await expect.poll(() => wp.sidebarToggleX()).toBe(xBefore);
  // ...and no hamburger appears in the collapsed state either.
  await expect(wp.menuTrigger).toHaveCount(0);

  // Round trip: re-expanding was the other half of the flicker regression
  // (the cluster used to remount into the sidebar bar) — the toggle must
  // hold the same position through the expand too.
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
  await expect.poll(() => wp.sidebarToggleX()).toBe(xBefore);
});

test("the nav-cluster overlay renders after the title bars in DOM order", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  // Positive anchor: the overlay and its toggle actually rendered.
  await expect(wp.sidebarToggle).toBeVisible();

  // Drag-region invariant (PR #634): in the Electron shell, Chromium builds
  // the window's draggable region in DOCUMENT order — the overlay's `no-drag`
  // carve-out only wins if it comes after the title bars' `drag` rects. An
  // earlier-in-DOM overlay leaves the nav buttons covered by the drag region
  // (clicks start a window drag instead). Real drag-region hit-testing isn't
  // reachable from this browser harness, so DOM order is the assertable
  // projection; the page-object probe throws if either side goes missing.
  expect(await wp.navOverlayFollowsTitleBars()).toBe(true);

  // The invariant must hold in the collapsed state too — the workspace title
  // bar is the only drag surface then.
  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  expect(await wp.navOverlayFollowsTitleBars()).toBe(true);
});

test("the collapsed state persists across a reload", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect.poll(() => wp.readSidebarCollapsed()).toBe(true);

  await wp.reload();
  await wp.waitForReady();

  // The mount effect re-collapses from persisted state.
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "false");
});
