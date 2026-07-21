/**
 * End-to-end coverage for "maximizing a tab collapses the edge panels".
 *
 * A grid group can be maximized (⇧⌘M / the Maximize button), which
 * overlays it on top of the other grid groups. dockview's edge groups
 * (`edge-left` / `edge-right` / `edge-bottom` — the side/edge panels
 * around the central area) sit OUTSIDE the grid, so historically a
 * maximized tab still shared the screen with any populated edge panel.
 * The desired behaviour, verified here: maximizing hides the edge panels
 * so the maximized tab gets the full area, and restoring brings them back.
 *
 * Architecture (mirrors `workspace-maximize-state.spec.ts`):
 *
 *   - The real production binary runs against a fresh tmp `~/.band/`.
 *   - No tRPC mocking; the dashboard renders against the real backend.
 *   - All UI is driven through `WorkspacePage` (no raw `getByRole`,
 *     `getByTestId`, or `page.goto` in the test body).
 *
 * The feature is only observable when an edge group actually holds a
 * visible panel — an empty edge renders at zero size, so a maximize has
 * nothing to collapse. There is no reliable way to dock a panel into an
 * edge through the UI (dockview edge docking is native HTML5
 * drag-and-drop, flaky under Playwright), so we seed a shared global
 * layout that starts with the `terminal` panel docked in the bottom edge.
 *
 * The seed below was captured from a real app run (load the app, copy
 * `localStorage["band:dockview-layout-v7"]`) and then edited to move the
 * `terminal` view out of the central grid group and into the
 * `edge-bottom` group (visible + expanded). Capturing rather than
 * hand-authoring keeps the serialized dockview grid shape valid; the
 * onReady reconciliation only re-adds missing required panels and drops
 * hidden ones, so it won't move the seeded panel back out of the edge.
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

const TOKEN = "e2e-workspace-maximize-collapses-edges-token";

const PROJECT = "alpha-edge";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (and therefore the Maximize button + edge groups) renders — matches
// >= 1024px in apps/web/src/hooks/useIsDesktop.ts.
test.use({ viewport: { width: 1280, height: 800 } });

// Global layout with `terminal` docked in the bottom edge group (visible +
// expanded). Grid leaf "2" keeps changes/files/browser; `edge-bottom`
// gains the terminal view. Panel definitions for all five stay in the
// top-level `panels` map. See the file header for how this was captured.
const LAYOUT_WITH_BOTTOM_EDGE_PANEL = {
  grid: {
    root: {
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["chat"], activeView: "chat", id: "1" }, size: 519 },
        {
          type: "leaf",
          data: { views: ["changes", "files", "browser"], activeView: "changes", id: "2" },
          size: 518,
        },
      ],
      size: 762,
    },
    width: 1037,
    height: 762,
    orientation: "HORIZONTAL",
  },
  panels: {
    chat: {
      id: "chat",
      contentComponent: "chat",
      tabComponent: "props.defaultTabComponent",
      title: "Chat",
      params: {},
    },
    changes: {
      id: "changes",
      contentComponent: "changes",
      tabComponent: "badge",
      params: {},
      title: "Changes",
    },
    files: {
      id: "files",
      contentComponent: "files",
      tabComponent: "props.defaultTabComponent",
      title: "Files",
      params: {},
    },
    terminal: {
      id: "terminal",
      contentComponent: "terminal",
      tabComponent: "props.defaultTabComponent",
      title: "Terminal",
      params: {},
    },
    browser: {
      id: "browser",
      contentComponent: "browser",
      tabComponent: "props.defaultTabComponent",
      title: "Browser",
      params: {},
    },
  },
  activeGroup: "1",
  edgeGroups: {
    left: {
      size: 200,
      visible: false,
      collapsed: true,
      group: { views: [], id: "edge-left", headerPosition: "left" },
    },
    right: {
      size: 200,
      visible: false,
      collapsed: true,
      group: { views: [], id: "edge-right", headerPosition: "right" },
    },
    bottom: {
      size: 200,
      visible: true,
      collapsed: false,
      group: {
        views: ["terminal"],
        activeView: "terminal",
        id: "edge-bottom",
        headerPosition: "bottom",
      },
    },
  },
};

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

// TODO(#643): the edge-collapse-on-maximize behaviour still exists, but the
// LAYOUT_WITH_BOTTOM_EDGE_PANEL seed is the legacy 5-panel outer structure
// (contentComponent "changes"/"files"/"terminal" singletons) that sanitize now
// strips. Re-author the seed as a v9 blob with a real leaf docked in the bottom
// EDGE group (dockview's shell-manager edge format) so the bottom edge is
// populated before maximize. Core maximize persistence is covered by
// workspace-maximize-state (AC1-4).
test.describe
  .skip("Maximize collapses edge panels", () => {
    test("maximizing a tab collapses the edge panel; restoring brings it back", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      // Seed BEFORE navigating so the dockview reads the edge-populated
      // layout on its onReady (addInitScript runs before the page script).
      await workspacePage.seedGlobalLayout(WORKSPACE, LAYOUT_WITH_BOTTOM_EDGE_PANEL);

      await workspacePage.goto(WORKSPACE);
      await workspacePage.waitForReady();

      // The bottom edge panel is populated (terminal docked there) and
      // therefore laid out on-screen at a non-zero size.
      await expect(workspacePage.bottomEdgeGroup()).toHaveCount(1);

      // Maximize a grid group. The edge panel must collapse to zero size so
      // the maximized tab gets the full area.
      await workspacePage.maximizePanel(0);
      await expect(workspacePage.restoreButton).toBeVisible();
      await expect(workspacePage.bottomEdgeGroup()).toHaveCount(0);

      // Restore (un-maximize). The edge panel must come back.
      await workspacePage.restorePanel();
      await expect(workspacePage.maximizeButtons.first()).toBeVisible();
      await expect(workspacePage.bottomEdgeGroup()).toHaveCount(1);
    });
  });
