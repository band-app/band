/**
 * End-to-end coverage for "the Files-tab explorer keeps a FIXED PIXEL width
 * when the tab is maximized and restored".
 *
 * The explorer is a chrome column (VS Code's Primary Side Bar model), not a
 * proportional pane: whatever width the user drags it to must survive a resize
 * of the surrounding container. Maximizing the Files tab is exactly such a
 * resize — the group takes over the whole grid AND
 * `apps/web/src/lib/dockview-edge-groups.ts` collapses the edge panels, so the
 * container gets substantially wider.
 *
 * Regression: the width used to be persisted as a PERCENTAGE of the group and
 * the panel used react-resizable-panels' default
 * `groupResizeBehavior="preserve-relative-size"`, so maximizing scaled the
 * explorer up with the container. It is now
 * `groupResizeBehavior="preserve-pixel-size"` with a px-valued `defaultSize`
 * (`band-file-tree-width-px:<workspaceId>`), and the editor panel — which keeps
 * `preserve-relative-size` — absorbs the whole delta.
 *
 * Each test asserts BOTH halves of that contract:
 *   - the explorer's pixel width is unchanged across maximize AND restore, and
 *   - the editor's width really did change, so the test can't pass vacuously
 *     because the maximize did nothing.
 *
 * Architecture: real production server, real browser, no tRPC mocking; all UI
 * driven through `WorkspacePage` + `CodeBrowserPage`.
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-file-explorer-fixed-width-token";

const PROJECT = "explorer-width";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// Wide viewport: the Files tab drops to its mobile (toggle) layout when its own
// container is under 600 px, and with two grid groups side by side that needs a
// viewport well past 1280. See file-explorer-side.spec.ts for the same note.
test.use({ viewport: { width: 2400, height: 900 } });

/** Rounding slack: a panel's laid-out width is a fractional CSS px. */
const WIDTH_TOLERANCE_PX = 2;
/** How much wider the editor must get on maximize for the event to count as a
 *  real container resize (the grid roughly doubles the group's width, so this
 *  is a very loose floor). */
const MIN_EDITOR_GROWTH_PX = 200;
const DRAG_DX = 120;
const DEFAULT_TREE_WIDTH_PX = 240;

/** The viewport `test.use` pins above. */
const WIDE_VIEWPORT_PX = 2400;
/** Narrow enough that half the Files group is well under the width the squeeze
 *  test drags to, but wide enough that the group itself stays over
 *  CodeBrowserView's 600px mobile threshold — the Group must stay mounted. */
const NARROW_VIEWPORT_PX = 1700;
/** Drag target for the squeeze test: comfortably inside `maxSize` (50%) at the
 *  wide viewport, and comfortably outside it once narrowed. */
const WIDE_DRAG_DX = 260; // 240 → ~500px

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "notes.txt"), "hello\n");

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
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

// TODO(#643 Phase 5): file explorer moved to right sidepanel — the docked
// CodeBrowserView fixed-pixel-width explorer column (persisted under
// `band-file-tree-width-px:*`) was removed in Phase 2. The sidepanel width is
// managed by the outer app-shell right Panel, not this per-Files-tab column.
// Re-enable when the sidepanel explorer is reworked.
test.describe
  .skip("Files-tab explorer keeps its pixel width across maximize", () => {
    test("maximizing and restoring the Files tab leaves the explorer's width untouched", async ({
      page,
    }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      const explorerBefore = await codeBrowser.explorerWidth();
      const editorBefore = await codeBrowser.editorWidth();

      // Maximize the group hosting the Files tab — the container-widening event.
      await codeBrowser.maximizeFilesGroup();
      await expect(workspace.restoreButton).toBeVisible();

      // The editor absorbs the delta: polling on ITS growth is both the wait for
      // the new layout to settle and the proof that the maximize actually
      // resized the container (without it, an inert maximize would let the
      // explorer assertion below pass for the wrong reason).
      await expect
        .poll(() => codeBrowser.editorWidth())
        .toBeGreaterThan(editorBefore + MIN_EDITOR_GROWTH_PX);

      expect(Math.abs((await codeBrowser.explorerWidth()) - explorerBefore)).toBeLessThanOrEqual(
        WIDTH_TOLERANCE_PX,
      );

      // Restore — the editor shrinks back and the explorer is still untouched.
      await codeBrowser.restoreFilesGroup();
      await expect(workspace.maximizeButtons.first()).toBeVisible();
      await expect
        .poll(() => codeBrowser.editorWidth())
        .toBeLessThan(editorBefore + MIN_EDITOR_GROWTH_PX);

      expect(Math.abs((await codeBrowser.explorerWidth()) - explorerBefore)).toBeLessThanOrEqual(
        WIDTH_TOLERANCE_PX,
      );
    });

    // Regression guard: the live layout used to be right while the width
    // PERSISTED during the maximize/restore layout event was not, so the dragged
    // width was silently lost on the next reload. See the note at the bottom.
    test("a width the user dragged to is the width preserved across maximize and reload", async ({
      page,
    }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      // Drag to a width that is clearly not the default, so "preserved" can't
      // mean "reset to the default that happened to match".
      await codeBrowser.dragSeparatorBy(DRAG_DX);
      await expect
        .poll(() => codeBrowser.explorerWidth())
        .toBeGreaterThan(DEFAULT_TREE_WIDTH_PX + DRAG_DX / 2);

      const draggedWidth = await codeBrowser.explorerWidth();
      const editorBefore = await codeBrowser.editorWidth();

      await codeBrowser.maximizeFilesGroup();
      await expect(workspace.restoreButton).toBeVisible();
      await expect
        .poll(() => codeBrowser.editorWidth())
        .toBeGreaterThan(editorBefore + MIN_EDITOR_GROWTH_PX);

      expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
        WIDTH_TOLERANCE_PX,
      );

      await codeBrowser.restoreFilesGroup();
      await expect(workspace.maximizeButtons.first()).toBeVisible();
      await expect
        .poll(() => codeBrowser.editorWidth())
        .toBeLessThan(editorBefore + MIN_EDITOR_GROWTH_PX);

      expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
        WIDTH_TOLERANCE_PX,
      );

      // The persisted value must still be the dragged pixel width — it is what
      // seeds the panel's `defaultSize` on the next mount. The write is debounced
      // (`WIDTH_PERSIST_DEBOUNCE_MS`), so poll rather than reading once.
      await expect
        .poll(async () => {
          const persisted = await codeBrowser.readPersistedWidthPx(WORKSPACE);
          return persisted === null
            ? null
            : Math.abs(persisted - draggedWidth) <= WIDTH_TOLERANCE_PX;
        })
        .toBe(true);

      // …and the user-visible consequence of getting that wrong: reload and the
      // explorer must come back at the width the user dragged it to.
      await workspace.reload();
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();
      expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
        WIDTH_TOLERANCE_PX,
      );
    });

    test("a legacy percentage width is ignored, not restored as a pixel width", async ({
      page,
    }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      // Users upgrading from the percentage era have `band-file-tree-width:<ws>`
      // = "15" (meaning 15% of the group). The key was deliberately renamed to
      // `-px`, because reusing it would restore that 15 as a 15-PIXEL explorer —
      // a sliver, below even the 10rem minSize. Seed the legacy key before the app
      // mounts and assert the explorer falls back to the 240px default.
      await codeBrowser.seedLegacyWidthValue(WORKSPACE, "15");

      await workspace.goto(WORKSPACE);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      expect(
        Math.abs((await codeBrowser.explorerWidth()) - DEFAULT_TREE_WIDTH_PX),
      ).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

      // The legacy value is not migrated into the new key — and nothing else is
      // written there either. Only a width the *user* chose is persisted, so
      // merely opening the tab leaves the key empty; the explorer falls back to
      // the default every mount until someone drags it.
      expect(await codeBrowser.readPersistedWidthPx(WORKSPACE)).toBeNull();

      // Once the user does drag, the new key takes over and the legacy one is
      // still never consulted.
      await codeBrowser.dragSeparatorBy(DRAG_DX);
      const dragged = await codeBrowser.explorerWidth();
      await expect
        .poll(async () => {
          const persisted = await codeBrowser.readPersistedWidthPx(WORKSPACE);
          return persisted === null ? null : Math.abs(persisted - dragged) <= WIDTH_TOLERANCE_PX;
        })
        .toBe(true);
    });

    test("a width squeezed out by a narrower window is reclaimed when the window widens back", async ({
      page,
    }) => {
      // `preserve-pixel-size` holds the explorer's width through a container
      // resize — but `maxSize` (50% of the group) still binds. Narrow the window
      // far enough and the layout engine MUST squeeze the explorer below the width
      // the user chose. It keeps no memory of the width it took away, so widening
      // back used to strand the explorer at the squeezed size, and the next persist
      // would then make that stranded width the user's "chosen" one.
      //
      // The fix: a container-driven `onResize` (group width changed) never
      // overwrites the chosen width — it re-asserts it instead, clamped to whatever
      // room there is now: `resize(min(chosenWidth, 50% of group))`.
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      // Drag the explorer wide (~500px) — inside `maxSize` at this viewport, but
      // well over half the group once the window narrows.
      await codeBrowser.dragSeparatorBy(WIDE_DRAG_DX);
      await expect
        .poll(() => codeBrowser.explorerWidth())
        .toBeGreaterThan(DEFAULT_TREE_WIDTH_PX + WIDE_DRAG_DX / 2);
      const chosenWidth = await codeBrowser.explorerWidth();

      // Let the debounced write land, so the persisted value under test is the
      // user's chosen width before any squeeze happens.
      await expect
        .poll(() => codeBrowser.readPersistedWidthPx(WORKSPACE))
        .toBe(Math.round(chosenWidth));

      // Narrow the window. The Group stays mounted (the Files container remains
      // above the 600px mobile threshold), but 50% of it is now less than the
      // chosen width, so the explorer is squeezed.
      await codeBrowser.setWindowWidth(NARROW_VIEWPORT_PX);
      await expect.poll(() => codeBrowser.explorerWidth()).toBeLessThan(chosenWidth - 20);

      // Widen back: the explorer must RECLAIM the width it chose, not stay stranded
      // at the squeezed size.
      await codeBrowser.setWindowWidth(WIDE_VIEWPORT_PX);
      await expect
        .poll(async () => Math.abs((await codeBrowser.explorerWidth()) - chosenWidth))
        .toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

      // And the squeeze never overwrote the user's chosen width on disk — otherwise
      // the next reload would come back at the squeezed size.
      expect(await codeBrowser.readPersistedWidthPx(WORKSPACE)).toBe(Math.round(chosenWidth));
    });
  });

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SECOND TEST EXISTS — the bug it caught, so it isn't relaxed later
 *
 * The LIVE pixel width always survived maximize/restore. What did not survive
 * was the PERSISTED width, so the explorer looked correct until the next reload.
 *
 * `CodeBrowserView`'s `handleLayoutChanged` used to read the explorer's width
 * synchronously inside the Group's `onLayoutChanged` callback. But
 * react-resizable-panels' `getSize()` is a live DOM read (`element.offsetWidth`,
 * see the library source) and `onLayoutChanged` fires BEFORE the new layout is
 * written to the DOM — so on a group-size change it measured the panel while it
 * was still sized by the OLD percentage inside the NEW container:
 *
 *     drag explorer to 360px      → live 360   persisted 360   ✅
 *     maximize the Files tab      → live 360   persisted 721   ❌ (360 × 2160/1080)
 *     restore                     → live 360   persisted 180   ❌ (360 × 1080/2160)
 *     reload                      → live 180                   ❌ dragged width lost
 *
 * (Real numbers from a 2400px viewport run.) Every maximize/restore cycle halved
 * the width the user chose, one reload later. The fix defers the `getSize()` read
 * to the next animation frame, once the settled layout is on screen.
 * ─────────────────────────────────────────────────────────────────────────────
 */
