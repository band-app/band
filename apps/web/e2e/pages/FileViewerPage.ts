/**
 * Page object for the workspace file viewer/editor (`FileViewer` →
 * `CodeMirrorEditor`).
 *
 * The viewer's root carries a `data-testid="file-viewer__root"` (set on
 * the `FileViewer` root element — distinct from the dockview panel's own
 * `file-viewer` test id) so we can scope the editor lookup to it and never
 * collide with the diff editors rendered in the Changes panel.
 *
 * `.cm-content` is CodeMirror-owned DOM (3rd-party class, same fragility
 * caveat as `ChangesPanelPage`'s `.cm-line`): the editor doesn't expose a
 * stable hook of its own for its content surface, and a CodeMirror major
 * upgrade that renamed it would flow through this one place. We scope it
 * under our own `file-viewer__root` test id so the brittle part is bounded.
 *
 * This is a SECONDARY page object — it owns no routes and constructs no
 * URLs, so it does NOT follow the `(page, baseUrl, …)` + `goto()`
 * convention of primary page objects.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

/** Test id on the `FileViewer` root element (set in FileViewer.tsx).
 *  Exported so other page objects that need to wait for the viewer to mount
 *  (e.g. `FileTreesPage.openFile`) reference the hook in one place rather
 *  than re-hardcoding the string. */
export const FILE_VIEWER_ROOT_TESTID = "file-viewer__root";

export class FileViewerPage {
  /**
   * @param page  The Playwright page.
   * @param scope Optional locator to scope the viewer lookup to a single
   *   workspace's subtree. Several workspace subtrees stay mounted at once
   *   (`MultiWorkspacePanelHost`'s LRU cache), so `file-viewer__root` can
   *   resolve to more than one element — pass a per-workspace scope (e.g.
   *   `workspacePage.cachedPanelEntries(id)`) to disambiguate. Defaults to the
   *   whole page for the common single-workspace case.
   */
  constructor(
    private readonly page: Page,
    private readonly scope?: Locator,
  ) {}

  /** The file viewer root, optionally scoped to a single workspace. */
  private get root(): Locator {
    return (this.scope ?? this.page).getByTestId(FILE_VIEWER_ROOT_TESTID);
  }

  /** The active file viewer's CodeMirror content element. */
  private get editor(): Locator {
    return this.root.locator(".cm-content").first();
  }

  /** The file viewer's load-error banner. Rendered by `FileViewer` when a
   *  read fails (e.g. an `ENOENT: no such file or directory, stat '<root>/<path>'`
   *  from the server's `stat`). `data-testid` set on the banner element in
   *  `FileViewer.tsx` so the assertion doesn't tie to the server error copy.
   *  Used by the cross-workspace-leak regression to prove a stray file from a
   *  DIFFERENT workspace never made this viewer attempt a stat that fails. */
  get errorBanner(): Locator {
    return this.root.getByTestId("file-viewer__error");
  }

  /** Assert (auto-retrying) that the editor's rendered text contains `text`. */
  async expectContent(text: string): Promise<void> {
    await test.step(`Editor shows "${text}"`, async () => {
      await expect(this.editor).toContainText(text, { timeout: 15_000 });
    });
  }

  /** Assert the editor's text does NOT contain `text`. Paired with a
   *  positive `expectContent` anchor at the call site (which is the real
   *  guard against a clobber); the generous window widens the chance of
   *  catching a late-arriving stale render rather than racing past it. */
  async expectNotContent(text: string): Promise<void> {
    await test.step(`Editor does not show "${text}"`, async () => {
      await expect(this.editor).not.toContainText(text, { timeout: 8_000 });
    });
  }

  /**
   * Replace the whole buffer with `text` (select-all + type). This makes
   * the tab dirty — the edited content differs from the on-disk baseline —
   * which is exactly the precondition for the "don't clobber unsaved edits"
   * behaviour under test.
   */
  async replaceAll(text: string): Promise<void> {
    await test.step(`Replace editor contents with "${text}"`, async () => {
      await this.editor.click();
      await this.page.keyboard.press("ControlOrMeta+a");
      await this.page.keyboard.type(text);
      await expect(this.editor).toContainText(text, { timeout: 15_000 });
    });
  }
}
