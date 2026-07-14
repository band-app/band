/**
 * End-to-end coverage for the Files-tab explorer's COLLAPSED state
 * (`band-file-tree-collapsed:<workspaceId>`), which had no e2e coverage at all.
 *
 * What makes this worth testing is how the restore is done. The explorer is not
 * mounted at size 0 — it mounts at its persisted pixel `defaultSize` and is then
 * collapsed imperatively in a `useLayoutEffect`:
 *
 *     if (treeCollapsed) treePanelRef.current?.collapse();
 *
 * …because `expand()` returns a panel to its last *uncollapsed* size, and a panel
 * that mounted at 0 has none — it would expand to the group's auto-assigned even
 * split instead of the width the user dragged. The effect is keyed on the same
 * things that remount the Group (`treeSide`, `useMobileLayout`), so it has to
 * re-collapse a freshly-mounted panel too, and it must do so before the browser
 * paints — otherwise the library's ResizeObserver measures the panel expanded and
 * reports a blip that would persist `collapsed = false`.
 *
 * The three scenarios below are exactly those claims:
 *   1. collapse survives a reload (the fresh-mount path),
 *   2. collapse survives a Group REMOUNT, and expanding afterwards returns the
 *      explorer to the width the user dragged it to (not an even split),
 *   3. collapse + docking side + width all restore together.
 *
 * ── A note on how the remount is driven ──────────────────────────────────────
 * The review asked for the remount to be driven by `moveExplorerRight()`. That is
 * not reachable while the explorer is collapsed: the move-explorer context menu's
 * trigger is the "Files" toolbar, which lives INSIDE the collapsed panel and is
 * therefore 0px wide and un-right-clickable (verified — the click times out).
 * `remountGroupViaWindowResize()` drives the other input to the very same
 * `useLayoutEffect` (`useMobileLayout`) with a real user action — narrowing the
 * window until the Files tab's container drops under CodeBrowserView's 600px
 * threshold, then restoring it — which unmounts and remounts the Group while the
 * explorer is collapsed. Scenario 3 then covers the side-flip half of the
 * interaction the only way the UI allows: flip while expanded, collapse, reload.
 *
 * The collapse itself is driven through BOTH affordances: the separator's chevron
 * (scenario 1) and the tab bar's tree-toggle (the rest). Expanding always goes
 * through the tab bar — see `CodeBrowserPage.toggleExplorerCollapsed` for why the
 * chevron is unusable in that direction.
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
import { CodeBrowserPage } from "./pages/CodeBrowserPage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-file-explorer-collapse-token";

const PROJECT = "explorer-collapse";
const BRANCH = "main";
const FILE = "notes.txt";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// Wide viewport — the Files tab falls back to its mobile single-column layout
// when its own container is under 600px. Same reasoning as the sibling specs.
test.use({ viewport: { width: 2400, height: 900 } });

const DEFAULT_TREE_WIDTH_PX = 240;
const DRAG_DX = 120;
const WIDTH_TOLERANCE_PX = 2;

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const dir = join(tmpHome, PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), "hello\n");

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: dir,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: dir }],
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

test.describe("Files-tab explorer collapsed state", () => {
  test("collapsing the explorer survives a reload", async ({ page }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const codeBrowser = new CodeBrowserPage(page, workspace);
    const trees = new FileTreesPage(page, workspace);

    await workspace.goto(WORKSPACE);
    await workspace.waitForReady();
    await codeBrowser.openFilesTab();
    // Open a file first: CodeBrowserView deliberately auto-expands the tree when
    // no editor tabs are open (issue #424 — otherwise a collapsed tree strands
    // the user with no navigation UI), so a collapse only sticks with a tab open.
    await trees.openFile(FILE);

    const editorBefore = await codeBrowser.editorWidth();

    await codeBrowser.collapseExplorerViaSeparatorChevron();

    // Positive anchor for the "explorer is gone" assertion: the editor took over
    // the space the explorer used to occupy.
    await expect.poll(() => codeBrowser.editorWidth()).toBeGreaterThan(editorBefore + 100);
    expect(await codeBrowser.isExplorerCollapsed()).toBe(true);
    await expect.poll(() => codeBrowser.readPersistedCollapsed(WORKSPACE)).toBe("true");

    await workspace.reload();
    await workspace.waitForReady();
    await codeBrowser.openFilesTab();

    // Still collapsed after the fresh mount, and still recorded as such.
    expect(await codeBrowser.isExplorerCollapsed()).toBe(true);
    expect(await codeBrowser.readPersistedCollapsed(WORKSPACE)).toBe("true");

    // And the user can get it back — with the flag flipped, so the expand is
    // persisted too.
    await codeBrowser.toggleExplorerCollapsed();
    await expect.poll(() => codeBrowser.isExplorerCollapsed()).toBe(false);
    await expect.poll(() => codeBrowser.readPersistedCollapsed(WORKSPACE)).toBe("false");
  });

  test("the explorer stays collapsed across a Group remount and expands back to the dragged width", async ({
    page,
  }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const codeBrowser = new CodeBrowserPage(page, workspace);
    const trees = new FileTreesPage(page, workspace);

    await workspace.goto(WORKSPACE);
    await workspace.waitForReady();
    await codeBrowser.openFilesTab();
    await trees.openFile(FILE);

    // Drag to a width that is clearly neither the 240px default nor an even
    // split of the group, so "expands back to the dragged width" is falsifiable.
    await codeBrowser.dragSeparatorBy(DRAG_DX);
    await expect
      .poll(() => codeBrowser.explorerWidth())
      .toBeGreaterThan(DEFAULT_TREE_WIDTH_PX + DRAG_DX / 2);
    const draggedWidth = await codeBrowser.explorerWidth();
    // The width write is debounced; let it land before collapsing, so the value
    // under test is the persisted one and not a leftover in memory.
    await expect
      .poll(() => codeBrowser.readPersistedWidthPx(WORKSPACE))
      .toBe(Math.round(draggedWidth));

    await codeBrowser.toggleExplorerCollapsed();
    await expect.poll(() => codeBrowser.isExplorerCollapsed()).toBe(true);

    // Remount the Group with the explorer collapsed. If the imperative
    // `collapse()` lost the race with the library's ResizeObserver, the panel
    // would come back expanded at its `defaultSize` here.
    await codeBrowser.remountGroupViaWindowResize();

    expect(await codeBrowser.isExplorerCollapsed()).toBe(true);
    expect(await codeBrowser.readPersistedCollapsed(WORKSPACE)).toBe("true");

    // Expanding returns it to the DRAGGED width — the whole reason the panel is
    // mounted at `defaultSize` and collapsed imperatively rather than mounted at
    // size 0 (which would expand to the group's even split instead).
    await codeBrowser.toggleExplorerCollapsed();
    await expect.poll(() => codeBrowser.isExplorerCollapsed()).toBe(false);
    expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
      WIDTH_TOLERANCE_PX,
    );
  });

  test("collapsing immediately after a drag still persists the dragged width", async ({ page }) => {
    // Regression guard for the debounce data-loss window.
    //
    // The width write is debounced (~200ms). An earlier implementation captured
    // the width in the Group's `onLayoutChanged` behind a `requestAnimationFrame`;
    // collapsing inside the debounce window dropped the width the user had just
    // dragged to and persisted the PREVIOUS one instead. Observed on that build:
    // drag 240 → 360, collapse at once, reload + expand → the explorer came back
    // at 240, and `band-file-tree-width-px` still held 240.
    //
    // That is a realistic gesture — the collapse chevron sits ON the separator the
    // user has just been dragging — which is why this test deliberately does NOT
    // wait for the debounced write to land before collapsing, and why it collapses
    // via the CHEVRON (where the cursor already is, so the click lands within tens
    // of ms) rather than via the tab bar (a cursor journey of ~100ms, long enough
    // for a deferred write to get in first).
    //
    // Width capture now lives in the tree Panel's `onResize`, delivered from the
    // library's own ResizeObserver — i.e. post-layout, so nothing has to be
    // deferred, and a collapsed `onResize` (which reports 0) is skipped rather
    // than cancelling anything. The pending debounced write therefore survives the
    // collapse and lands with the dragged width.
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const codeBrowser = new CodeBrowserPage(page, workspace);
    const trees = new FileTreesPage(page, workspace);

    await workspace.goto(WORKSPACE);
    await workspace.waitForReady();
    await codeBrowser.openFilesTab();
    await trees.openFile(FILE);

    await codeBrowser.dragSeparatorBy(DRAG_DX);
    const draggedWidth = await codeBrowser.explorerWidth();
    expect(draggedWidth).toBeGreaterThan(DEFAULT_TREE_WIDTH_PX + DRAG_DX / 2);

    // Collapse straight away — no poll on the persisted width first. The collapse
    // goes through the SEPARATOR CHEVRON, not the tab bar: the chevron is where
    // the cursor already is after a drag, so the click lands within a few tens of
    // ms. (Driving this through the tab-bar toggle instead takes ~100ms — enough
    // for the old implementation's rAF to fire first, which is why that variant
    // does NOT reproduce the bug.)
    await codeBrowser.collapseExplorerViaSeparatorChevron();
    await expect.poll(() => codeBrowser.isExplorerCollapsed()).toBe(true);

    // The pending write must still land, carrying the DRAGGED width.
    await expect
      .poll(() => codeBrowser.readPersistedWidthPx(WORKSPACE))
      .toBe(Math.round(draggedWidth));

    // …and the user-visible consequence: reload, expand, and the explorer is the
    // width the user dragged it to — not the default it would have fallen back to.
    await workspace.reload();
    await workspace.waitForReady();
    await codeBrowser.openFilesTab();
    expect(await codeBrowser.isExplorerCollapsed()).toBe(true);

    await codeBrowser.toggleExplorerCollapsed();
    await expect.poll(() => codeBrowser.isExplorerCollapsed()).toBe(false);
    expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
      WIDTH_TOLERANCE_PX,
    );
    expect(await codeBrowser.readPersistedWidthPx(WORKSPACE)).toBe(Math.round(draggedWidth));
  });

  test("collapsed + docked right + dragged width all restore together after a reload", async ({
    page,
  }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const codeBrowser = new CodeBrowserPage(page, workspace);
    const trees = new FileTreesPage(page, workspace);

    await workspace.goto(WORKSPACE);
    await workspace.waitForReady();
    await codeBrowser.openFilesTab();
    await trees.openFile(FILE);

    await codeBrowser.dragSeparatorBy(DRAG_DX);
    await expect
      .poll(() => codeBrowser.explorerWidth())
      .toBeGreaterThan(DEFAULT_TREE_WIDTH_PX + DRAG_DX / 2);
    const draggedWidth = await codeBrowser.explorerWidth();
    await expect
      .poll(() => codeBrowser.readPersistedWidthPx(WORKSPACE))
      .toBe(Math.round(draggedWidth));

    // Flip the side (only possible while expanded — the context-menu trigger is
    // inside the panel), THEN collapse. The width must survive the Group remount
    // the side flip causes.
    await codeBrowser.moveExplorerRight();
    await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(true);
    expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
      WIDTH_TOLERANCE_PX,
    );

    await codeBrowser.toggleExplorerCollapsed();
    await expect.poll(() => codeBrowser.isExplorerCollapsed()).toBe(true);
    await expect.poll(() => codeBrowser.readPersistedCollapsed(WORKSPACE)).toBe("true");

    await workspace.reload();
    await workspace.waitForReady();
    await codeBrowser.openFilesTab();

    // All three pieces of state come back: collapsed, docked right (the
    // separator sits right of the editor even at zero explorer width), and — on
    // expand — the dragged width.
    expect(await codeBrowser.isExplorerCollapsed()).toBe(true);
    expect(await codeBrowser.separatorIsRightOfEditor()).toBe(true);

    await codeBrowser.toggleExplorerCollapsed();
    await expect.poll(() => codeBrowser.isExplorerCollapsed()).toBe(false);
    expect(await codeBrowser.explorerIsRightOfEditor()).toBe(true);
    expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
      WIDTH_TOLERANCE_PX,
    );
  });
});
