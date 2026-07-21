/**
 * End-to-end coverage for "the Files-tab explorer can be docked left or right".
 *
 * The explorer's header row ("Files") is a Radix context-menu trigger with two
 * items — "Explorer on Left" / "Explorer on Right". The chosen side is kept per
 * workspace in `localStorage` under `band-file-tree-side:<workspaceId>` and
 * re-ordered in the DOM by remounting the resizable Group with the panels in
 * the opposite order.
 *
 * Architecture (mirrors the rest of the e2e suite):
 *
 *   - The REAL production `dist/start-server.mjs` boots against a fresh tmp
 *     `$HOME` with on-disk project directories. No tRPC mocking.
 *   - Everything is driven through page objects (`WorkspacePage` +
 *     `CodeBrowserPage`); the test body never touches `page.*`.
 *
 * The side is asserted GEOMETRICALLY (explorer's `x` vs the editor's `x`) —
 * that's what the user sees — with the persisted `localStorage` value asserted
 * alongside it, so a regression in either the render order or the persistence
 * fails the test.
 *
 * The last scenario guards the invariant that moving sides must not RESIZE the
 * explorer: `handleSetTreeSide` reads the panel's live pixel width before the
 * Group remounts and re-seeds the fresh panel's `defaultSize` with it.
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

const TOKEN = "e2e-file-explorer-side-token";

const PROJECT_A = "explorer-side-a";
const PROJECT_B = "explorer-side-b";
const BRANCH = "main";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, BRANCH);
const WORKSPACE_B = toWorkspaceId(PROJECT_B, BRANCH);

// The Files tab falls back to its mobile (toggle) layout whenever its own
// container is narrower than 600 px — with two grid groups side by side that
// means the viewport has to be wide enough for the files group to clear 600 px
// on its own. 2400 px leaves ~1000 px per group (same reasoning as
// copy-file-path.spec.ts, which needs the Changes tree's container query).
test.use({ viewport: { width: 2400, height: 900 } });

// `DEFAULT_FILE_TREE_WIDTH_PX` in CodeBrowserView.tsx. Duplicated rather than
// imported (tests don't import production code) — the drag scenario needs a
// target width that is unmistakably NOT the default, so a side flip that
// silently reset the panel to its default width can't pass.
const DEFAULT_TREE_WIDTH_PX = 240;
const DRAG_DX = 120;
/** Rounding slack: the panel's laid-out width is a fractional CSS px. */
const WIDTH_TOLERANCE_PX = 2;

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  for (const project of [PROJECT_A, PROJECT_B]) {
    const dir = join(tmpHome, project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "hello\n");
  }
  seedState(tmpHome, {
    projects: [PROJECT_A, PROJECT_B].map((name) => ({
      name,
      path: join(tmpHome, name),
      defaultBranch: BRANCH,
      worktrees: [{ branch: BRANCH, path: join(tmpHome, name) }],
    })),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

// TODO(#643 Phase 5): file explorer moved to right sidepanel — the docked
// two-panel CodeBrowserView (with a left/right-dockable explorer column) was
// removed in Phase 2, so there is no explorer docking side to test. Re-enable
// (repoint or delete) when the sidepanel explorer affordances are reworked.
test.describe
  .skip("Files-tab explorer docking side", () => {
    test("defaults to the left edge", async ({ page }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE_A);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      const explorer = await codeBrowser.explorerBox();
      const editor = await codeBrowser.editorBox();
      expect(explorer.x).toBeLessThan(editor.x);

      // Nothing persisted yet — "left" is the unset fallback, not a stored value.
      expect(await codeBrowser.readPersistedSide(WORKSPACE_A)).toBeNull();
    });

    test('"Explorer on Right" moves it to the right edge and persists the choice', async ({
      page,
    }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE_A);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();
      expect(await codeBrowser.explorerIsRightOfEditor()).toBe(false);

      await codeBrowser.moveExplorerRight();

      // The Group remounts with the panels in the opposite order, so poll the
      // geometry rather than reading it once.
      await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(true);
      expect(await codeBrowser.readPersistedSide(WORKSPACE_A)).toBe("right");
    });

    test("the chosen side survives a full page reload", async ({ page }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE_A);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();
      await codeBrowser.moveExplorerRight();
      await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(true);

      await workspace.reload();
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(true);
      expect(await codeBrowser.readPersistedSide(WORKSPACE_A)).toBe("right");
    });

    test("the side is per-workspace — moving it in one workspace leaves the other on the left", async ({
      page,
    }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE_A);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();
      await codeBrowser.moveExplorerRight();
      await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(true);

      // Workspace B has never been moved: it renders with the explorer on the
      // left and has no persisted side of its own.
      await workspace.goto(WORKSPACE_B);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(false);
      expect(await codeBrowser.readPersistedSide(WORKSPACE_B)).toBeNull();
      // …and A's choice was not clobbered by the visit to B.
      expect(await codeBrowser.readPersistedSide(WORKSPACE_A)).toBe("right");
    });

    test("moving between sides keeps the explorer's dragged width", async ({ page }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const codeBrowser = new CodeBrowserPage(page, workspace);

      await workspace.goto(WORKSPACE_A);
      await workspace.waitForReady();
      await codeBrowser.openFilesTab();

      // Drag the explorer to a width that is unmistakably not the 240 px default,
      // so the assertions below can't pass just because both sides happen to fall
      // back to the same default.
      await codeBrowser.dragSeparatorBy(DRAG_DX);
      await expect
        .poll(() => codeBrowser.explorerWidth())
        .toBeGreaterThan(DEFAULT_TREE_WIDTH_PX + DRAG_DX / 2);
      const draggedWidth = await codeBrowser.explorerWidth();

      // Move right: same width, opposite edge.
      await codeBrowser.moveExplorerRight();
      await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(true);
      expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
        WIDTH_TOLERANCE_PX,
      );

      // …and back to the left: still the same width.
      await codeBrowser.moveExplorerLeft();
      await expect.poll(() => codeBrowser.explorerIsRightOfEditor()).toBe(false);
      expect(Math.abs((await codeBrowser.explorerWidth()) - draggedWidth)).toBeLessThanOrEqual(
        WIDTH_TOLERANCE_PX,
      );

      // The dragged width — not the default — is what got persisted. The width
      // write is debounced (`WIDTH_PERSIST_DEBOUNCE_MS`), so poll for it.
      await expect
        .poll(async () => {
          const persisted = await codeBrowser.readPersistedWidthPx(WORKSPACE_A);
          return persisted === null
            ? null
            : Math.abs(persisted - draggedWidth) <= WIDTH_TOLERANCE_PX;
        })
        .toBe(true);
    });
  });
