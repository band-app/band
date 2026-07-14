/**
 * Page object for the Files tab's two-panel code browser (`CodeBrowserView`):
 * the explorer (file tree) column, the editor column, and the separator
 * between them.
 *
 * It owns the two behaviours the specs drive:
 *
 *   - **Docking side** — the "Files" toolbar's right-click context menu moves
 *     the explorer to the left or right edge of the tab
 *     (`band-file-tree-side:<workspaceId>`).
 *   - **Width** — the explorer is a fixed-*pixel* column
 *     (`band-file-tree-width-px:<workspaceId>`), so it must survive container
 *     resizes (maximize / restore) and side flips unchanged.
 *
 * Locators:
 *
 *   - `file-tree__toolbar`, `file-tree__move-left`, `file-tree__move-right` are
 *     BEM `data-testid`s we set in `CodeBrowserView.tsx`.
 *   - `file-tree`, `file-viewer` and `file-tree-separator` are the panel /
 *     separator elements. react-resizable-panels renders each element's `id`
 *     prop onto BOTH `id` and `data-testid`, so those testids come straight
 *     from the `<Panel id="file-tree">` / `<Panel id="file-viewer">` /
 *     `<Separator id="file-tree-separator">` declarations in the same file —
 *     a library-provided test hook, addressed by testid rather than by a CSS
 *     or `#id` selector.
 *
 * This is a SECONDARY page object (same shape as `FileTreesPage`): it owns no
 * routes and constructs no URLs, so it takes a `WorkspacePage` and delegates
 * navigation, tab activation and maximize/restore to it.
 */

import { type Locator, type Page, test } from "@playwright/test";
import type { WorkspacePage } from "./WorkspacePage";

/** localStorage keys written by `CodeBrowserView` (mirrors `fileTreeSideKey` /
 *  `fileTreeWidthKey` in the source — duplicated here rather than imported, so
 *  a rename in production has to be a conscious change on both sides). */
const SIDE_KEY_PREFIX = "band-file-tree-side:";
const WIDTH_PX_KEY_PREFIX = "band-file-tree-width-px:";

export class CodeBrowserPage {
  constructor(
    private readonly page: Page,
    private readonly workspace: WorkspacePage,
  ) {}

  /** The "Files" header row of the explorer — the context-menu trigger for the
   *  move-explorer actions. */
  get toolbar(): Locator {
    return this.page.getByTestId("file-tree__toolbar");
  }

  get moveLeftMenuItem(): Locator {
    return this.page.getByTestId("file-tree__move-left");
  }

  get moveRightMenuItem(): Locator {
    return this.page.getByTestId("file-tree__move-right");
  }

  /** The explorer panel (`<Panel id="file-tree">`). */
  get explorerPanel(): Locator {
    return this.page.getByTestId("file-tree");
  }

  /** The editor panel (`<Panel id="file-viewer">`). */
  get editorPanel(): Locator {
    return this.page.getByTestId("file-viewer");
  }

  /** The drag handle between them (`<Separator id="file-tree-separator">`). */
  get separator(): Locator {
    return this.page.getByTestId("file-tree-separator");
  }

  /** Activate the outer Files tab and wait for the desktop side-by-side layout
   *  to mount. Anchors on the explorer's toolbar rather than a tree row so the
   *  helper doesn't depend on the seeded project's contents. */
  async openFilesTab(): Promise<void> {
    await test.step("Open the Files tab", async () => {
      await this.workspace.activateTab("files");
      await this.toolbar.waitFor({ state: "visible", timeout: 15_000 });
      await this.explorerPanel.waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Bounding box of the explorer panel. Throws rather than returning null so
   *  callers get a useful failure instead of a confusing `undefined` compare. */
  async explorerBox(): Promise<{ x: number; width: number }> {
    const box = await this.explorerPanel.boundingBox();
    if (!box) throw new Error("Explorer panel has no bounding box (not rendered?)");
    return { x: box.x, width: box.width };
  }

  /** Bounding box of the editor panel. */
  async editorBox(): Promise<{ x: number; width: number }> {
    const box = await this.editorPanel.boundingBox();
    if (!box) throw new Error("Editor panel has no bounding box (not rendered?)");
    return { x: box.x, width: box.width };
  }

  async explorerWidth(): Promise<number> {
    return (await this.explorerBox()).width;
  }

  async editorWidth(): Promise<number> {
    return (await this.editorBox()).width;
  }

  /** Whether the explorer currently sits to the RIGHT of the editor. The
   *  geometric, user-observable signal for the docking side: the Group renders
   *  its children in DOM order (tree, separator, viewer — or the reverse), so
   *  the panels' `x` offsets are what the user actually sees. */
  async explorerIsRightOfEditor(): Promise<boolean> {
    const [explorer, editor] = await Promise.all([this.explorerBox(), this.editorBox()]);
    return explorer.x > editor.x;
  }

  /** Right-click the "Files" toolbar and dock the explorer to `side`. Drives
   *  the exact surface the user does: the Radix context menu on the toolbar. */
  async moveExplorer(side: "left" | "right"): Promise<void> {
    await test.step(`Move the explorer to the ${side}`, async () => {
      await this.toolbar.click({ button: "right" });
      const item = side === "left" ? this.moveLeftMenuItem : this.moveRightMenuItem;
      await item.waitFor({ state: "visible" });
      await item.click();
      // The Group is keyed on the side, so it fully remounts. Waiting for the
      // menu to leave the DOM keeps a back-to-back move from clicking a portal
      // that is still fading out.
      await item.waitFor({ state: "hidden" });
      await this.explorerPanel.waitFor({ state: "visible" });
    });
  }

  async moveExplorerRight(): Promise<void> {
    await this.moveExplorer("right");
  }

  async moveExplorerLeft(): Promise<void> {
    await this.moveExplorer("left");
  }

  /** Drag the separator horizontally by `dx` CSS px — a real mouse press /
   *  move / release, so it goes through react-resizable-panels' pointer
   *  resize path exactly as a user's drag does. */
  async dragSeparatorBy(dx: number): Promise<void> {
    await test.step(`Drag the explorer separator by ${dx}px`, async () => {
      const box = await this.separator.boundingBox();
      if (!box) throw new Error("Separator has no bounding box (not rendered?)");
      const y = box.y + box.height / 2;
      const startX = box.x + box.width / 2;
      await this.page.mouse.move(startX, y);
      await this.page.mouse.down();
      // Intermediate steps: the resize handler tracks pointermove, and a single
      // jump can be coalesced or land outside the drag threshold.
      await this.page.mouse.move(startX + dx / 2, y, { steps: 5 });
      await this.page.mouse.move(startX + dx, y, { steps: 5 });
      await this.page.mouse.up();
    });
  }

  /** Maximize the outer dockview group that hosts the Files tab — the
   *  container-widening event the fixed-pixel width has to survive. */
  async maximizeFilesGroup(): Promise<void> {
    await this.workspace.maximizeGroupContaining("files");
  }

  /** Exit maximize (delegates to the shared header Restore button). */
  async restoreFilesGroup(): Promise<void> {
    await this.workspace.restorePanel();
  }

  /** The persisted docking side. `null` when nothing has been written yet
   *  (production then defaults to "left"). */
  async readPersistedSide(workspaceId: string): Promise<string | null> {
    return await this.page.evaluate(([prefix, id]) => localStorage.getItem(`${prefix}${id}`), [
      SIDE_KEY_PREFIX,
      workspaceId,
    ] as const);
  }

  /** The persisted explorer width in px. `null` when nothing has been written
   *  yet. Returned as a number so specs can compare it against a measured
   *  bounding box. */
  async readPersistedWidthPx(workspaceId: string): Promise<number | null> {
    const raw = await this.page.evaluate(([prefix, id]) => localStorage.getItem(`${prefix}${id}`), [
      WIDTH_PX_KEY_PREFIX,
      workspaceId,
    ] as const);
    return raw === null ? null : Number(raw);
  }
}
