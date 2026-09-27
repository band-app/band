/**
 * End-to-end coverage for loading a saved layout that still holds dockview
 * edge groups.
 *
 * The center dockview used to dock panels into left / right / bottom edge
 * groups around the grid. Edge groups were removed, but layouts saved before
 * that still carry an `edgeGroups` entry in `band:dockview-layout-v9:<ws>`.
 * Loading one must keep every panel: `sanitizeSavedLayout` moves the edge
 * groups' panels into the first grid group as tabs and drops `edgeGroups`, so
 * dockview never recreates an edge group.
 *
 * File leaves are used because they are pure client views with no server
 * record. The onReady reconcile re-adds missing chats / terminals / browsers
 * from the server, but never a file leaf, so a file tab that shows up can only
 * have come from the saved layout.
 *
 * Architecture (matches the repo's integration doctrine):
 *   - The real production server runs against a fresh tmp `~/.band/`.
 *   - No tRPC mocking. One project with a real directory holding the seeded
 *     files, so the file leaves open real files.
 *   - All UI is driven through `WorkspacePage`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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

const TOKEN = "e2e-workspace-legacy-edge-layout-token";
const PROJECT = "alpha-legacy-edge";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

const GRID_FILE = "README.md";
const BOTTOM_EDGE_FILE = "notes.md";
const LEFT_EDGE_FILE = "guide.md";

// Wide viewport so the desktop layout (and the split-capable dockview) renders
// (>= 1024px in useIsDesktop.ts).
test.use({ viewport: { width: 1400, height: 800 } });

function filePanel(path: string) {
  return {
    id: `file:${path}`,
    contentComponent: "file",
    tabComponent: "file",
    title: path,
    params: {},
  };
}

// A v9 layout as dockview's `toJSON()` wrote it while edge groups existed: one
// grid group with a file tab, a populated bottom edge, a populated (collapsed)
// left edge, and an empty right edge. The bottom edge also lists a view with
// no panel entry, and the left edge holds a `terminal` singleton, a panel kind
// that no longer exists. Neither may cost the layout its other tabs.
const LAYOUT_WITH_EDGE_GROUPS = {
  grid: {
    root: {
      type: "branch",
      data: [
        {
          type: "leaf",
          data: { views: [`file:${GRID_FILE}`], activeView: `file:${GRID_FILE}`, id: "1" },
          size: 1000,
        },
      ],
      size: 700,
    },
    width: 1000,
    height: 700,
    orientation: "HORIZONTAL",
  },
  panels: {
    [`file:${GRID_FILE}`]: filePanel(GRID_FILE),
    [`file:${BOTTOM_EDGE_FILE}`]: filePanel(BOTTOM_EDGE_FILE),
    [`file:${LEFT_EDGE_FILE}`]: filePanel(LEFT_EDGE_FILE),
    terminal: {
      id: "terminal",
      contentComponent: "terminal",
      tabComponent: "props.defaultTabComponent",
      title: "Terminal",
      params: {},
    },
  },
  activeGroup: "1",
  edgeGroups: {
    left: {
      size: 200,
      visible: true,
      collapsed: true,
      group: {
        views: [`file:${LEFT_EDGE_FILE}`, "terminal"],
        activeView: `file:${LEFT_EDGE_FILE}`,
        id: "edge-left",
        headerPosition: "left",
      },
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
        views: [`file:${BOTTOM_EDGE_FILE}`, "file:missing-panel-entry.md"],
        activeView: `file:${BOTTOM_EDGE_FILE}`,
        id: "edge-bottom",
        headerPosition: "bottom",
      },
    },
  },
};

// The same layout with no grid group left: the user had closed every grid tab
// and only the edge groups held panels.
const LAYOUT_WITH_ONLY_EDGE_GROUPS = {
  ...LAYOUT_WITH_EDGE_GROUPS,
  grid: {
    ...LAYOUT_WITH_EDGE_GROUPS.grid,
    root: { type: "branch", data: [], size: 700 },
  },
  panels: {
    [`file:${BOTTOM_EDGE_FILE}`]: filePanel(BOTTOM_EDGE_FILE),
    [`file:${LEFT_EDGE_FILE}`]: filePanel(LEFT_EDGE_FILE),
  },
  activeGroup: "edge-bottom",
};

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const projectPath = join(tmpHome, PROJECT);
  mkdirSync(projectPath, { recursive: true });
  for (const file of [GRID_FILE, BOTTOM_EDGE_FILE, LEFT_EDGE_FILE]) {
    writeFileSync(join(projectPath, file), `# ${file}\n`);
  }
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: projectPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: projectPath }],
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

test("a saved layout with edge groups loads with the edge panels as tabs in the grid", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  // Seed BEFORE navigating: `addInitScript` writes localStorage ahead of the
  // page script, so the dockview restores this layout on its first onReady.
  await wp.seedGlobalLayout(WORKSPACE, LAYOUT_WITH_EDGE_GROUPS);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  // Every panel survives, including the two that were docked at the edges.
  await expect(wp.fileTab(GRID_FILE)).toBeVisible();
  await expect(wp.fileTab(BOTTOM_EDGE_FILE)).toBeVisible();
  await expect(wp.fileTab(LEFT_EDGE_FILE)).toBeVisible();

  // No edge group was recreated from the saved layout.
  await expect(wp.edgeGroups()).toHaveCount(0);

  // The moved panels sit in the grid group's tab strip, next to the grid tab,
  // rather than in a strip at the bottom or left of the window.
  const gridTab = await wp.boxOf(wp.fileTab(GRID_FILE));
  const bottomTab = await wp.boxOf(wp.fileTab(BOTTOM_EDGE_FILE));
  const leftTab = await wp.boxOf(wp.fileTab(LEFT_EDGE_FILE));
  expect(bottomTab.y).toBe(gridTab.y);
  expect(leftTab.y).toBe(gridTab.y);
  expect(bottomTab.x).toBeGreaterThan(gridTab.x);
  expect(leftTab.x).toBeGreaterThan(gridTab.x);
});

test("a saved layout whose panels were all in edge groups loads them into a new grid group", async ({
  page,
}) => {
  const wp = new WorkspacePage(page, server.url, TOKEN);
  await wp.seedGlobalLayout(WORKSPACE, LAYOUT_WITH_ONLY_EDGE_GROUPS);
  await wp.goto(WORKSPACE);
  await wp.waitForReady();

  await expect(wp.fileTab(BOTTOM_EDGE_FILE)).toBeVisible();
  await expect(wp.fileTab(LEFT_EDGE_FILE)).toBeVisible();
  await expect(wp.edgeGroups()).toHaveCount(0);

  // Both panels share one tab strip.
  const bottomTab = await wp.boxOf(wp.fileTab(BOTTOM_EDGE_FILE));
  const leftTab = await wp.boxOf(wp.fileTab(LEFT_EDGE_FILE));
  expect(bottomTab.y).toBe(leftTab.y);
});
