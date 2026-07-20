/**
 * Regression coverage for the chat / terminal panels landing in a
 * collapsed edge group on cold mount.
 *
 * Background
 * ----------
 * Each inner dockview (`DockviewChatContainer`,
 * `DockviewTerminalContainer`, `DockviewBrowserContainer`) calls
 * `ensureEdgeGroups` in `onReady` to add three cardinal edge groups
 * (`edge-left`, `edge-right`, `edge-bottom`), all collapsed and empty.
 * dockview-core 6.0.6 falls back to `activeGroup` when `api.addPanel`
 * is called without a `position` — and when `activeGroup` happens to
 * be one of those collapsed edge groups (e.g. because the inner
 * dockview's seed path is async and runs AFTER `ensureEdgeGroups`),
 * the new panel is appended INTO the edge group instead of the
 * central area. Visually this renders as a thin docked strip at the
 * bottom of the section instead of a normal full-area pane.
 *
 * The fix pins every positionless `addPanel` call site to the central
 * area via the `centralPanelPosition` helper in
 * `apps/web/src/lib/dockview-edge-groups.ts`: prefer
 * `{ referenceGroup: <id> }` when a grid-located group exists, and
 * otherwise return `{ direction: "within" }` to force dockview to
 * create a brand-new central group at location `[0]` regardless of
 * what `activeGroup` happens to be.
 *
 * What this spec asserts
 * ----------------------
 * For each of the chat / terminal containers we:
 *   1. Boot the real server with an empty `panel_states` table (no
 *      seeded layout for the workspace).
 *   2. Open the workspace and let the inner dockview's `onReady` run
 *      its default-seed path (chat: `createDefaultPanel`; terminal:
 *      `seedFromConfigOrDefault`).
 *   3. Wait for the layout to be persisted server-side (the inner
 *      containers debounce-save to `chat_layout` / `terminal_layout`
 *      panel state rows via tRPC).
 *   4. Read the persisted layout via `chatLayout.get` /
 *      `terminalLayout.get` and assert the freshly-seeded panel's id
 *      is in a leaf whose group id is NOT one of `edge-left`,
 *      `edge-right`, `edge-bottom`. Equivalently: the panel sits in a
 *      central (grid-located) leaf, which is what the user expects.
 *
 * The terminal test is the most direct regression catch — the
 * `seedFromConfigOrDefault` async path is the documented race that
 * reliably reproduces the bug on cold-start. The chat test codifies
 * the contract for the analogous chat call sites.
 *
 * Out of scope: browser container
 * -------------------------------
 * The fix in `DockviewBrowserContainer` (default panel +
 * `browser-created` subscription) mirrors the chat container line-for-
 * line, but `BrowserPanelComponent` in `SharedDockviewLayout.tsx`
 * skips `DockviewBrowserContainer` entirely on the web build (only
 * the Electron desktop build mounts it — see the `if (!isDesktop)`
 * branch). The TypeScript + biome + structural review covers the
 * symbol-level half of the fix on that container; a runtime
 * regression catch requires desktop e2e coverage which this web-build
 * spec can't provide. Same shape and rationale as
 * `panel-visibility-context.spec.ts`'s scope note. The
 * `WorkspacePage.readInnerLayout("browser", …)` helper is kept so a
 * future desktop e2e harness can wire up the missing third test
 * without re-deriving the tRPC path.
 */

import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { EDGE_GROUP_IDS } from "@/lib/dockview-edge-groups";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import type { DockviewGridNode, DockviewLayoutSnapshot } from "./pages/WorkspacePage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-panel-default-position-token";

const PROJECT = "alpha-panel-default";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared
// dockview (which hosts the inner containers under test) renders.
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
  // Clear the per-workspace shared-dockview state so each test starts
  // with the default outer layout (Chat on the left,
  // Terminal/Changes/Files/Browser on the right). The page-object
  // method centralises the localStorage key construction so the test
  // body never reaches for the prefix inline.
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.resetDockviewActiveStateAndGoto(WORKSPACE);
});

// ---------------------------------------------------------------------------
// Layout traversal helper
// ---------------------------------------------------------------------------

/** Walk a dockview grid tree and return the id of the leaf whose
 *  `views` array contains `panelId`. Returns `undefined` when the
 *  panel id is not present anywhere in the tree. */
function findContainingLeafId(layout: DockviewLayoutSnapshot, panelId: string): string | undefined {
  const root = layout.grid?.root;
  if (!root) return undefined;

  const visit = (node: DockviewGridNode): string | undefined => {
    if (node.type === "leaf") {
      return node.data.views.includes(panelId) ? node.data.id : undefined;
    }
    for (const child of node.data) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };

  return visit(root);
}

/** Leaf ids `ensureEdgeGroups` injects into every inner dockview. A
 *  panel landing in any of these is the bug. Re-uses the production
 *  constant so adding a fourth edge in `ensureEdgeGroups` automatically
 *  extends the regression check. */
const FORBIDDEN_LEAF_IDS = new Set<string>(Object.values(EDGE_GROUP_IDS));

/** Poll the inner container's tRPC `*.Layout.get` endpoint until it
 *  returns a layout that contains at least one panel, then return the
 *  resolved layout. The 500 ms persistence debounce inside each inner
 *  container means the layout briefly looks "empty" after onReady —
 *  this helper waits for the debounced save to land before the test
 *  asserts on it. */
async function pollForLayoutWithPanels(
  workspacePage: WorkspacePage,
  container: "chat" | "terminal" | "browser",
  workspaceId: string,
): Promise<DockviewLayoutSnapshot> {
  let layout: DockviewLayoutSnapshot | undefined;
  await expect
    .poll(
      async () => {
        const tree = await workspacePage.readInnerLayout(container, workspaceId);
        if (!tree || Object.keys(tree.panels).length === 0) return false;
        layout = tree;
        return true;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  if (!layout) {
    throw new Error(`pollForLayoutWithPanels(${container}): poll returned true but no layout`);
  }
  return layout;
}

/** Shared body for each container's regression test. Reads the freshly
 *  persisted layout, locates the seeded panel's leaf, and asserts the
 *  leaf id is not one of the collapsed edge-group ids. The terminal
 *  test additionally drives the outer tab activation before this runs
 *  (the inner container doesn't mount until the outer tab is active);
 *  the chat container is already mounted on workspace load. */
async function assertSeededPanelInCentralArea(
  workspacePage: WorkspacePage,
  container: "chat" | "terminal" | "browser",
  workspaceId: string,
): Promise<void> {
  const layout = await pollForLayoutWithPanels(workspacePage, container, workspaceId);
  const panelIds = Object.keys(layout.panels);
  // The default-seed path creates exactly one panel — a second one
  // would indicate the seed ran twice (the bug some earlier
  // refactors of this code path actually introduced) and is worth
  // surfacing as a test failure.
  expect(panelIds).toHaveLength(1);
  const panelId = panelIds[0];
  const leafId = findContainingLeafId(layout, panelId);
  expect(leafId, `${container} panel ${panelId} is not in any leaf`).toBeDefined();
  expect(FORBIDDEN_LEAF_IDS.has(leafId as string)).toBe(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TODO(#643 Phase 5): re-point to Cmd+D split / new toolbar. This spec asserts
// the old per-container inner-dockview persistence model (chatLayout.get /
// terminalLayout.get via readInnerLayout) and the edge-group-leak behaviour of
// those inner dockviews. The unified center dockview persists to localStorage
// (band:dockview-layout-v8:<id>) with no server-side projection to assert on.
test.describe
  .skip("Panel default position (regression: edge-group leak)", () => {
    test("Chat container's default panel lands in a central (grid) group, not an edge group", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      await workspacePage.goto(WORKSPACE);
      await workspacePage.waitForReady();

      // Positive anchor: the default chat tab is visible. This proves
      // the chat container's `onReady` has actually run — without it the
      // `chatLayout.get` poll below could pass simply because nothing
      // was ever persisted.
      await expect(workspacePage.chatTabVisibilityMarker(WORKSPACE, true)).toBeVisible();

      await assertSeededPanelInCentralArea(workspacePage, "chat", WORKSPACE);
    });

    test("Terminal container's default panel lands in a central (grid) group, not an edge group", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      await workspacePage.goto(WORKSPACE);
      await workspacePage.waitForReady();

      // Activate the outer Terminal tab so the inner
      // `DockviewTerminalContainer` mounts and its `onReady` runs the
      // `seedFromConfigOrDefault` async path that the bug originated in.
      await workspacePage.tab("terminal").click();

      // Positive anchor: the default terminal tab is visible. Confirms
      // the inner container's seed path actually ran AND the tab is
      // showing in the central area (a panel in a collapsed edge group
      // resolves to a `visible-true` test id, since the React component
      // still sees `parentVisible && tabActive`, but the dockview wrapper
      // hides it — so this also doubles as a coarse pre-check of the
      // regression assertion below).
      await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE, true)).toBeVisible();

      await assertSeededPanelInCentralArea(workspacePage, "terminal", WORKSPACE);
    });

    // Browser container test deliberately omitted — see the
    // "Out of scope: browser container" section of the file docstring
    // for the rationale and the migration path when desktop e2e
    // coverage lands.
  });
