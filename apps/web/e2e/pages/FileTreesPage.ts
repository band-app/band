/**
 * Page object for the two workspace file trees and their right-click
 * "Copy relative path" / "Copy absolute path" context-menu actions:
 *
 *   - Files view  → `FileBrowser` (the "files" outer dockview tab).
 *   - Changes view → `ChangesFileTree` (the sidebar inside the "changes"
 *     outer dockview tab's DiffView).
 *
 * Row buttons carry a `data-testid` of `file-tree__row--<path>` /
 * `changes-tree__row--<path>` (set in the respective components), and each
 * copy menu item carries a stable `data-testid` — so the test body never
 * depends on the localisable menu copy or on CSS structure.
 *
 * Outer-dockview tab navigation and clipboard capture live on `WorkspacePage`
 * (the suite's single owner of the `workspace__tab--*` locators), so this
 * object takes a `WorkspacePage` and delegates tab switching to it rather than
 * re-deriving the tab testids.
 */

import { type Locator, type Page, test } from "@playwright/test";
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

  /** Activate the Files tab and wait for the given row to render. */
  async openFilesTab(path: string): Promise<void> {
    await test.step("Open the Files tab", async () => {
      await this.workspace.tab("files").click();
      await this.fileTreeRow(path).waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Activate the Changes tab and wait for the given row to render in the
   *  changes sidebar tree. */
  async openChangesTab(path: string): Promise<void> {
    await test.step("Open the Changes tab", async () => {
      await this.workspace.tab("changes").click();
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
}
