/**
 * Page object for an extension's editor tab (`ExtensionEditor`): the sandboxed frame, the fixture
 * editor's textarea inside it, the dirty dot, the "changed on disk" banner and "Open With…".
 *
 * The frame has an opaque origin, so everything inside it is reached through `frameLocator`.
 * Tabs are told apart by the file path the editor container carries.
 */

import { expect, type FrameLocator, type Locator, type Page, test } from "@playwright/test";
import type { FileTreesPage } from "./FileTreesPage";
import type { WorktreePage } from "./WorktreePage";

export const FIXTURE_EDITOR_REF = "text-editor/text";

export class ExtensionEditorPage {
  constructor(
    private readonly page: Page,
    private readonly worktree: WorktreePage,
    private readonly trees: FileTreesPage,
  ) {}

  /** The editor container of one open file. */
  editor(path: string): Locator {
    return this.page.locator(`[data-testid="extension-editor"][data-file-path="${path}"]`);
  }

  frame(path: string): FrameLocator {
    return this.editor(path).frameLocator('[data-testid="extension-editor__frame"]');
  }

  textarea(path: string): Locator {
    return this.frame(path).getByRole("textbox", { name: "Document text" });
  }

  status(path: string): Locator {
    return this.frame(path).getByTestId("status");
  }

  get builtinViewer(): Locator {
    return this.page.getByTestId("file-viewer__root");
  }

  /** What the fixture editor could read from inside the sandbox, as JSON. */
  probe(path: string): Locator {
    return this.frame(path).getByTestId("probe");
  }

  dirtyDot(path: string): Locator {
    return this.page.getByTestId(`center-file-tab__dirty--${path}`);
  }

  get conflictBanner(): Locator {
    return this.page.getByTestId("center-file-leaf__remote-edit");
  }

  get loadTheirs(): Locator {
    return this.page.getByTestId("center-file-leaf__remote-edit-load");
  }

  get keepMine(): Locator {
    return this.page.getByTestId("center-file-leaf__remote-edit-keep");
  }

  /** Show a file's row in the Explorer. The folder's expansion is synced between windows, so it may already be open. */
  async revealFile(folder: string, path: string): Promise<void> {
    await this.trees.openFilesTab(folder);
    if (!(await this.trees.fileTreeRow(path).isVisible())) {
      await this.trees.expandFileTreeFolder(folder, path);
    }
    await this.trees.waitForFileTreeRow(path);
  }

  /** Open a file from the Explorer and wait until the editor has its text. */
  async open(path: string): Promise<void> {
    await test.step(`Open ${path} from the Explorer`, async () => {
      await this.trees.clickFile(path);
      await expect(this.editor(path)).toHaveAttribute("data-ready", "true");
    });
  }

  /** Brings the file's tab to the front. */
  async showTab(path: string): Promise<void> {
    await test.step(`Show the tab of ${path}`, async () => {
      await this.worktree.fileTab(path).click();
    });
  }

  /** Closes the file's tab with its × button. */
  async closeTab(path: string): Promise<void> {
    await this.worktree.closeFileTab(path);
  }

  async replaceText(path: string, text: string): Promise<void> {
    await test.step(`Type into ${path}`, async () => {
      await this.textarea(path).fill(text);
    });
  }

  /** Selects characters `start` to `end` of the document and tells the editor, as a mouse drag does. */
  async selectText(path: string, start: number, end: number): Promise<void> {
    await test.step(`Select characters ${start}-${end} in ${path}`, async () => {
      await this.textarea(path).evaluate(
        (el, range) => {
          const area = el as HTMLTextAreaElement;
          area.focus();
          area.setSelectionRange(range.start, range.end);
          area.dispatchEvent(new Event("select", { bubbles: true }));
        },
        { start, end },
      );
    });
  }

  /** The layout the editor was last told: `compact`, `regular`, or `none` before it hears one. */
  layout(path: string): Locator {
    return this.frame(path).getByTestId("layout");
  }

  /** The Save button of the compact layout. */
  saveButton(path: string): Locator {
    return this.editor(path).getByTestId("extension-editor__save");
  }

  async save(path: string): Promise<void> {
    await test.step(`Press Cmd+S in ${path}`, async () => {
      await this.textarea(path).press("ControlOrMeta+s");
    });
  }

  // --- Open With… ---

  private async chooseOpenWith(prefix: string, itemTestId: string): Promise<void> {
    await this.page.getByTestId(`${prefix}__open-with`).click();
    await this.page.getByTestId(itemTestId).click();
  }

  /** The "Open With…" entries of the Explorer row's menu. */
  async explorerOpenWithEntries(path: string): Promise<Locator> {
    await this.trees.openFileTreeMenu(path);
    await this.page.getByTestId("file-tree__open-with").click();
    return this.page.getByTestId("file-tree__open-with-menu");
  }

  openWithItem(prefix: string, ref: string): Locator {
    return this.page.getByTestId(`${prefix}__open-with--${ref}`);
  }

  setDefaultItem(prefix: string, ref: string): Locator {
    return this.page.getByTestId(`${prefix}__set-default--${ref}`);
  }

  async openFromExplorerWith(path: string, ref: string): Promise<void> {
    await test.step(`Explorer: Open With ${ref} for ${path}`, async () => {
      await this.trees.openFileTreeMenu(path);
      await this.chooseOpenWith("file-tree", `file-tree__open-with--${ref}`);
    });
  }

  tabMenuPrefix(path: string): string {
    return `center-file-tab--${path}`;
  }

  async openTabMenu(path: string): Promise<void> {
    await this.worktree.fileTab(path).click({ button: "right" });
  }

  async switchTabEditor(path: string, ref: string): Promise<void> {
    await test.step(`Tab menu: Open With ${ref} for ${path}`, async () => {
      await this.openTabMenu(path);
      const prefix = this.tabMenuPrefix(path);
      await this.chooseOpenWith(prefix, `${prefix}__open-with--${ref}`);
    });
  }

  async setTabDefault(path: string, ref: string): Promise<void> {
    await test.step(`Tab menu: set ${ref} as default for ${path}`, async () => {
      await this.openTabMenu(path);
      const prefix = this.tabMenuPrefix(path);
      await this.page.getByTestId(`${prefix}__open-with`).click();
      await this.setDefaultItem(prefix, ref).click();
    });
  }
}
