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

test("the collapsed state persists across a reload", async ({ page }) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  await wp.toggleSidebarViaButton();
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  expect(await wp.readSidebarCollapsed()).toBe(true);

  await wp.reload();
  await wp.waitForReady();

  // The mount effect re-collapses from persisted state.
  await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
  await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "false");
});
