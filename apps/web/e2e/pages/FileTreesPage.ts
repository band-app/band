/**
 * Page object for the two workspace file trees and their right-click
 * "Copy relative path" / "Copy absolute path" context-menu actions:
 *
 *   - Files view  → `FileBrowser` (the Explorer section of the right
 *     sidepanel).
 *   - Changes view → `ChangesFileTree` (the Changes section of the right
 *     sidepanel).
 *
 * Both trees moved out of the center dockview and into the persistent right
 * sidepanel in #643 Phase 2 (`RightSidepanel.tsx`, rendered in `__root.tsx`).
 * The sidepanel is visible by default; `openFilesTab` / `openChangesTab`
 * therefore reveal it (via `WorkspacePage.revealRightPanel`) and interact with
 * the always-mounted tree rows rather than clicking a center tab.
 *
 * Row buttons carry a `data-testid` of `file-tree__row--<path>` /
 * `changes-tree__row--<path>` (set in the respective components), and each
 * copy menu item carries a stable `data-testid` — so the test body never
 * depends on the localisable menu copy or on CSS structure.
 *
 * This is a SECONDARY page object: it owns no routes and constructs no URLs,
 * so it intentionally does NOT follow the `(page, baseUrl, …)` + `goto()`
 * convention of primary page objects. All navigation (URL construction,
 * `goto`) and clipboard capture live on `WorkspacePage`, which is passed in and
 * delegated to for revealing the sidepanel rather than re-deriving its testids
 * here.
 */

import { type Locator, type Page, test } from "@playwright/test";
import { FILE_VIEWER_ROOT_TESTID } from "./FileViewerPage";
import type { WorkspacePage } from "./WorkspacePage";

export class FileTreesPage {
  constructor(
    private readonly page: Page,
    private readonly workspace: WorkspacePage,
  ) {}

  /** A row in the Files tree (`FileBrowser`), keyed by its
   *  workspace-relative path. */
  fileTreeRow(path: string): Locator {
    return this.page.getByTestId(`file-tree__row--${path}`);
  }

  /** A row in the Changes tree (`ChangesFileTree`), keyed by its
   *  workspace-relative path. */
  changesTreeRow(path: string): Locator {
    return this.page.getByTestId(`changes-tree__row--${path}`);
  }

  /** "Copy relative path" / "Copy absolute path" items for each tree.
   *
   *  These testids are NOT row-keyed — every row's menu uses the same id.
   *  That's safe here because Radix keeps only the one open context menu
   *  mounted, and these specs right-click a single row at a time. A future
   *  multi-row scenario that opens one row's menu while another's is still
   *  fading out (Radix portals during the close transition) would need to
   *  scope these under the specific open menu container instead. */
  get fileTreeCopyRelative(): Locator {
    return this.page.getByTestId("file-tree__copy-relative-path");
  }
  get fileTreeCopyAbsolute(): Locator {
    return this.page.getByTestId("file-tree__copy-absolute-path");
  }
  get changesTreeCopyRelative(): Locator {
    return this.page.getByTestId("changes-tree__copy-relative-path");
  }
  get changesTreeCopyAbsolute(): Locator {
    return this.page.getByTestId("changes-tree__copy-absolute-path");
  }

  /** Reveal the right sidepanel and wait for the given Files-tree row to render
   *  in the Explorer section. The Explorer section is open by default; the tree
   *  rows are `FileBrowser`'s `file-tree__row--<path>` buttons (#643 Phase 2
   *  moved the tree here from the removed `center-tab--files` singleton). */
  async openFilesTab(path: string): Promise<void> {
    await test.step("Open the Explorer section (right sidepanel)", async () => {
      await this.workspace.revealRightPanel();
      await this.workspace.explorerSection.waitFor({ state: "visible", timeout: 15_000 });
      await this.fileTreeRow(path).waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Reveal the right sidepanel and wait for the given Changes-tree row to
   *  render in the Changes section. The Changes section is open by default (and
   *  its body only mounts when there is at least one change); the rows are
   *  `ChangesFileTree`'s `changes-tree__row--<path>` buttons (#643 Phase 2 moved
   *  the tree here from the removed `center-tab--changes` singleton). */
  async openChangesTab(path: string): Promise<void> {
    await test.step("Open the Changes section (right sidepanel)", async () => {
      await this.workspace.revealRightPanel();
      // The panel defaults to Explorer; select Changes so its body mounts.
      await this.workspace.selectRightPanelTab("changes");
      await this.workspace.changesSection.waitFor({ state: "visible", timeout: 15_000 });
      await this.changesTreeRow(path).waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Expand a directory row in the Files tree (lazy-loads its children) and
   *  wait for the expected child row to appear. Clicking a directory row
   *  toggles its expansion in `FileBrowser`; the load is async, so callers
   *  pass the child they're about to act on so the right-click can't race
   *  the lazy fetch. */
  async expandFileTreeFolder(path: string, awaitChild: string): Promise<void> {
    await test.step(`Expand Files-tree folder ${path}`, async () => {
      await this.fileTreeRow(path).click();
      await this.fileTreeRow(awaitChild).waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Click a file row in the Files tree to open it in the file viewer, and
   *  wait for the viewer to mount. Clicking a *file* row (as opposed to a
   *  directory row, which `expandFileTreeFolder` toggles) drives
   *  `FileBrowser`'s `onSelectRow(..., "file")`, which opens the tab and
   *  mounts `FileViewer`. */
  async openFile(path: string): Promise<void> {
    await test.step(`Open file ${path} in the viewer`, async () => {
      await this.fileTreeRow(path).click();
      await this.page
        .getByTestId(FILE_VIEWER_ROOT_TESTID)
        .waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Wait for a Files-tree row to appear (e.g. after an external file was
   *  created and the watcher-driven tree refresh should surface it). */
  async waitForFileTreeRow(path: string): Promise<void> {
    await test.step(`Wait for Files-tree row ${path}`, async () => {
      await this.fileTreeRow(path).waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Right-click a Files-tree row to open its context menu. */
  async openFileTreeMenu(path: string): Promise<void> {
    await test.step(`Right-click Files-tree row ${path}`, async () => {
      await this.fileTreeRow(path).click({ button: "right" });
    });
  }

  /** Right-click a Changes-tree row to open its context menu. */
  async openChangesTreeMenu(path: string): Promise<void> {
    await test.step(`Right-click Changes-tree row ${path}`, async () => {
      await this.changesTreeRow(path).click({ button: "right" });
    });
  }

  // -------------------------------------------------------------------------
  // Explorer header toolbar + file operations (new / rename / cut / copy /
  // paste / delete / drag-and-drop). Menu items carry `file-tree__<action>`
  // testids; the same single-open-menu caveat as the copy-path getters applies.
  // -------------------------------------------------------------------------

  /** A header toolbar button: New File, New Folder, Refresh, Collapse all. */
  headerButton(action: "new-file" | "new-folder" | "refresh" | "collapse-all"): Locator {
    return this.page.getByTestId(`explorer-header__${action}`);
  }

  /** The inline name input used by New File / New Folder / Rename. */
  get nameInput(): Locator {
    return this.page.getByTestId("file-tree__name-input");
  }

  /** The Delete dialog's confirm button. */
  get deleteConfirmButton(): Locator {
    return this.page.getByTestId("file-tree__delete-confirm");
  }

  /** The scrollable tree container; empty space in it targets the root. */
  get treeRoot(): Locator {
    return this.page.getByTestId("file-tree__root");
  }

  /** The dismissable banner a failed paste or drop shows above the tree. */
  get errorBanner(): Locator {
    return this.page.getByTestId("file-tree__error");
  }

  menuItem(
    action: "new-file" | "new-folder" | "cut" | "copy" | "paste" | "rename" | "delete",
  ): Locator {
    return this.page.getByTestId(`file-tree__${action}`);
  }

  /** Hover the Explorer header (its actions show on hover) and click one. */
  async clickHeaderButton(
    action: "new-file" | "new-folder" | "refresh" | "collapse-all",
  ): Promise<void> {
    await test.step(`Click Explorer header ${action}`, async () => {
      await this.headerButton(action).hover();
      await this.headerButton(action).click();
    });
  }

  /** Type a name into the inline name input and submit it with Enter. */
  async submitName(name: string): Promise<void> {
    await test.step(`Submit name ${name}`, async () => {
      await this.nameInput.waitFor({ state: "visible" });
      await this.nameInput.fill(name);
      await this.nameInput.press("Enter");
    });
  }

  /** Right-click a Files-tree row and pick an action from its menu. */
  async runRowAction(
    path: string,
    action: "new-file" | "new-folder" | "cut" | "copy" | "paste" | "rename" | "delete",
  ): Promise<void> {
    await test.step(`Run ${action} on Files-tree row ${path}`, async () => {
      await this.openFileTreeMenu(path);
      await this.menuItem(action).click();
      // The item's action runs once the menu has finished closing, so wait
      // for that before the next interaction opens another menu.
      await this.menuItem(action).waitFor({ state: "hidden" });
    });
  }

  /** Select a row with a click, then press a key while the tree has focus. */
  async pressOnRow(path: string, key: string): Promise<void> {
    await test.step(`Press ${key} on Files-tree row ${path}`, async () => {
      await this.fileTreeRow(path).click();
      await this.fileTreeRow(path).press(key);
    });
  }

  /** Confirm the Delete dialog. */
  async confirmDelete(): Promise<void> {
    await test.step("Confirm delete", async () => {
      await this.deleteConfirmButton.click();
    });
  }

  /** Drag a Files-tree row onto another row (a folder lands inside it, a file
   *  lands beside it). `copy` holds Alt during the drag, which copies. */
  async dragRowOnto(from: string, to: string, opts?: { copy?: boolean }): Promise<void> {
    await test.step(`Drag ${from} onto ${to}${opts?.copy ? " (copy)" : ""}`, async () => {
      if (opts?.copy) await this.page.keyboard.down("Alt");
      try {
        await this.fileTreeRow(from).dragTo(this.fileTreeRow(to));
      } finally {
        if (opts?.copy) await this.page.keyboard.up("Alt");
      }
    });
  }

  /** Drag a Files-tree row onto the empty area below the rows (the root). */
  async dragRowToRoot(from: string): Promise<void> {
    await test.step(`Drag ${from} to the workspace root`, async () => {
      const box = await this.treeRoot.boundingBox();
      const lastRow = await this.page
        .getByTestId(/^file-tree__row--/)
        .last()
        .boundingBox();
      if (!box || !lastRow) throw new Error("file tree has no bounding box");
      // Refuse when the rows fill the tree: a drop on a row targets its folder.
      if (lastRow.y + lastRow.height >= box.y + box.height - 8) {
        throw new Error("no empty space below the rows to drop on");
      }
      // Drop halfway between the last row and the bottom of the tree.
      const y = (lastRow.y + lastRow.height + box.y + box.height) / 2 - box.y;
      await this.fileTreeRow(from).dragTo(this.treeRoot, {
        targetPosition: { x: box.width / 2, y },
      });
    });
  }

  /** Named action methods for the copy menu items, so the test body drives
   *  interactions through the page object rather than clicking raw locators.
   *  The matching getters above remain for `expect(...).toBeVisible()`
   *  assertions. */
  async clickFileCopyRelative(): Promise<void> {
    await test.step("Click Files-tree Copy relative path", async () => {
      await this.fileTreeCopyRelative.click();
    });
  }
  async clickFileCopyAbsolute(): Promise<void> {
    await test.step("Click Files-tree Copy absolute path", async () => {
      await this.fileTreeCopyAbsolute.click();
    });
  }
  async clickChangesCopyRelative(): Promise<void> {
    await test.step("Click Changes-tree Copy relative path", async () => {
      await this.changesTreeCopyRelative.click();
    });
  }
  async clickChangesCopyAbsolute(): Promise<void> {
    await test.step("Click Changes-tree Copy absolute path", async () => {
      await this.changesTreeCopyAbsolute.click();
    });
  }
}
