/**
 * Page object for the worktree file viewer/editor (`FileViewer` →
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
 * `.cm-scroller` (CodeMirror's scroll container, `previewScroller`) has the
 * same caveat and is scoped under `file-viewer__markdown-preview`.
 *
 * This is a SECONDARY page object — it owns no routes and constructs no
 * URLs, so it does NOT follow the `(page, baseUrl, …)` + `goto()`
 * convention of primary page objects.
 */

import { type Download, expect, type Locator, type Page, test } from "@playwright/test";
import { CodeSymbolLinks } from "./CodeSymbolLinks";
import { FindWidget } from "./FindWidget";
import { MarkdownTableEditor } from "./MarkdownTableEditor";

/** Test id on the `FileViewer` root element (set in FileViewer.tsx).
 *  Exported so other page objects that need to wait for the viewer to mount
 *  (e.g. `FileTreesPage.openFile`) reference the hook in one place rather
 *  than re-hardcoding the string. */
export const FILE_VIEWER_ROOT_TESTID = "file-viewer__root";

export class FileViewerPage {
  /**
   * @param page  The Playwright page.
   * @param scope Optional locator to scope the viewer lookup to a single
   *   worktree's subtree. Several worktree subtrees stay mounted at once
   *   (`MultiWorktreePanelHost`), so `file-viewer__root` can
   *   resolve to more than one element — pass a per-worktree scope (e.g.
   *   `worktreePage.cachedPanelEntries(id)`) to disambiguate. Defaults to the
   *   whole page for the common single-worktree case.
   */
  constructor(
    private readonly page: Page,
    private readonly scope?: Locator,
  ) {}

  /** The file viewer root, optionally scoped to a single worktree. */
  private get root(): Locator {
    return (this.scope ?? this.page).getByTestId(FILE_VIEWER_ROOT_TESTID);
  }

  /** The floating find widget over this viewer's content (source or
   *  markdown preview). */
  get findWidget(): FindWidget {
    return new FindWidget(this.root);
  }

  /** Every file or preview find input on the whole page, unscoped, so a spec
   *  can assert exactly one opened (the "stacked bars" regression, #435). */
  get allFileFindInputs(): Locator {
    return this.page.getByPlaceholder(/Find in (preview|file)\.\.\./);
  }

  /** Go-to-definition (Cmd/Ctrl+hover link, Cmd/Ctrl+Click) in the editor. */
  get symbols(): CodeSymbolLinks {
    return new CodeSymbolLinks(this.page, this.root);
  }

  /** The active file viewer's CodeMirror content element. */
  private get editor(): Locator {
    return this.root.locator(".cm-content").first();
  }

  /** The file viewer's load-error banner. Rendered by `FileViewer` when a
   *  read fails (e.g. an `ENOENT: no such file or directory, stat '<root>/<path>'`
   *  from the server's `stat`). `data-testid` set on the banner element in
   *  `FileViewer.tsx` so the assertion doesn't tie to the server error copy.
   *  Used by the cross-worktree-leak regression to prove a stray file from a
   *  DIFFERENT worktree never made this viewer attempt a stat that fails. */
  get errorBanner(): Locator {
    return this.root.getByTestId("file-viewer__error");
  }

  /** Read the editor's currently-rendered text. CodeMirror only renders the
   *  visible viewport, so this is reliable for the small single-line fixtures
   *  the worktree-scoping specs use. Returns "" when no viewer is mounted.
   *  Used for poll-for-appearance assertions (poll for a specific file's text
   *  arriving within a bounded window, then assert it never did). */
  async readText(): Promise<string> {
    const el = this.editor;
    if ((await el.count()) === 0) return "";
    return (await el.textContent()) ?? "";
  }

  /** Click into a rendered markdown preview (on its heading) so focus moves
   *  inside the file leaf, the way a user clicks into what they're reading.
   *  Cmd/Ctrl+F is scoped to the focused leaf. `headingName` is text from the
   *  fixture file the test wrote. */
  async clickIntoPreview(headingName: string): Promise<void> {
    await test.step(`Click into the markdown preview ("${headingName}")`, async () => {
      await this.root.getByRole("heading", { name: headingName }).first().click();
    });
  }

  /** The editable markdown preview (`file-viewer__markdown-preview`). */
  get markdownPreview(): Locator {
    return this.root.getByTestId("file-viewer__markdown-preview");
  }

  /** The markdown preview's width toggle in the file leaf's group header
   *  (`center-file-leaf__width-toggle`). `aria-pressed` is true in full
   *  width. The header sits outside the viewer root, so this is page-wide. */
  get previewWidthToggle(): Locator {
    return this.page.getByTestId("center-file-leaf__width-toggle");
  }

  /** Click the width toggle (narrow to full width, or back). */
  async togglePreviewWidth(): Promise<void> {
    await test.step("Toggle the markdown preview width", async () => {
      await this.previewWidthToggle.click();
    });
  }

  /** The markdown preview's scroll container (third-party class, see the
   *  header note). */
  private get previewScroller(): Locator {
    return this.markdownPreview.locator(".cm-scroller");
  }

  /** Widths in px of the preview pane and of its text column (CodeMirror's
   *  `.cm-content`, see the `editor` note above), and the column's side
   *  padding. The column width includes its padding. */
  async previewWidths(): Promise<{ pane: number; column: number; sidePadding: string }> {
    const pane = await this.markdownPreview.evaluate((el) => el.getBoundingClientRect().width);
    const { column, sidePadding } = await this.markdownPreview
      .locator(".cm-content")
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          column: el.getBoundingClientRect().width,
          sidePadding: `${style.paddingLeft} ${style.paddingRight}`,
        };
      });
    return { pane, column, sidePadding };
  }

  /** Scroll the preview until the heading `name` (fixture text) is at the
   *  top. CodeMirror only renders lines near the viewport, so it moves the
   *  cursor to the document start and wheels down until the heading exists,
   *  then brings it to the top. */
  async scrollPreviewToHeading(name: string): Promise<void> {
    await test.step(`Scroll the markdown preview to "${name}"`, async () => {
      const heading = this.markdownPreview.getByRole("heading", { name, exact: true });
      await this.scrollPreviewToTop();
      await this.markdownPreview.hover();
      await expect(async () => {
        if ((await heading.count()) === 0) await this.page.mouse.wheel(0, 600);
        await expect(heading).toBeAttached({ timeout: 250 });
      }).toPass({ timeout: 15_000 });
      await heading.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect
        .poll(async () => Math.abs(await this.previewHeadingOffset(name)))
        .toBeLessThan(5);
    });
  }

  /** Move the preview's cursor to the document start, which scrolls it to
   *  the top. */
  async scrollPreviewToTop(): Promise<void> {
    await test.step("Scroll the markdown preview to the top", async () => {
      await this.markdownPreview.getByRole("textbox").first().focus();
      await this.page.keyboard.press(
        process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
      );
      // CodeMirror keeps a small margin above the cursor line.
      await expect.poll(() => this.previewScrollTop()).toBeLessThan(100);
    });
  }

  /** The px distance from the top of the preview's scroll area to the heading
   *  `name`. Near 0 when the heading is at the top. */
  async previewHeadingOffset(name: string): Promise<number> {
    const heading = this.markdownPreview.getByRole("heading", { name, exact: true });
    const top = await heading.evaluate((el) => el.getBoundingClientRect().top);
    const scrollerTop = await this.previewScroller.evaluate((el) => el.getBoundingClientRect().top);
    return top - scrollerTop;
  }

  /** The preview scroller's scrollTop in px. */
  async previewScrollTop(): Promise<number> {
    return this.previewScroller.evaluate((el) => el.scrollTop);
  }

  /** A heading rendered in the markdown preview. Heading lines carry
   *  `role="heading"` + `aria-level`. */
  previewHeading(level: number, name: string): Locator {
    return this.markdownPreview.getByRole("heading", { level, name, exact: true });
  }

  /** An image the preview renders in place of `![alt](src)`. */
  previewImage(alt: string): Locator {
    return this.markdownPreview.getByRole("img", { name: alt, exact: true });
  }

  /** The loaded width of a preview image; 0 when its URL did not load. */
  async previewImageNaturalWidth(alt: string): Promise<number> {
    return this.previewImage(alt).evaluate((img) => (img as HTMLImageElement).naturalWidth);
  }

  /** Click the checkbox the preview renders for a task-list item. */
  async toggleTask(text: string): Promise<void> {
    await test.step(`Toggle the task "${text}"`, async () => {
      await this.taskCheckbox(text).click();
    });
  }

  /** Bold / inline-code / list-item text rendered in the markdown preview,
   *  located by the element's implicit role (`<strong>`, `<code>`) or the
   *  line's `role="listitem"`. */
  previewFormatted(role: "strong" | "code" | "listitem", text: string): Locator {
    return this.markdownPreview.getByRole(role).filter({ hasText: text });
  }

  /** A block the preview renders instead of showing its source (table,
   *  frontmatter, mermaid). */
  previewRenderedBlock(kind: "table" | "frontmatter" | "mermaid"): Locator {
    return this.markdownPreview.getByTestId(`markdown-preview__block--${kind}`);
  }

  /** The `<table>` inside the preview's rendered table block. */
  get previewTable(): Locator {
    return this.previewRenderedBlock("table").getByRole("table");
  }

  /** The editable table the preview renders for the `index`th table. */
  previewTableEditor(index = 0): MarkdownTableEditor {
    return new MarkdownTableEditor(
      this.page,
      this.previewRenderedBlock("table").nth(index),
      this.markdownPreview,
    );
  }

  /** The editable Key / Value grid the preview renders for the frontmatter. */
  previewFrontmatterEditor(): MarkdownTableEditor {
    return new MarkdownTableEditor(
      this.page,
      this.previewRenderedBlock("frontmatter"),
      this.markdownPreview,
      "Property",
    );
  }

  /** A control Streamdown renders in the corner of a rendered block, by the
   *  `title` Streamdown gives it ("Copy Code", "View fullscreen", ...). */
  previewBlockControl(kind: "table" | "frontmatter" | "mermaid", name: string): Locator {
    return this.previewRenderedBlock(kind).getByRole("button", { name, exact: true });
  }

  /** The close button of Streamdown's fullscreen diagram view. Streamdown
   *  portals that view to `document.body`, outside the file viewer. */
  get fullscreenExitButton(): Locator {
    return this.page.getByRole("button", { name: "Exit fullscreen", exact: true });
  }

  /** Click a rendered block's corner control. */
  async clickPreviewBlockControl(
    kind: "table" | "frontmatter" | "mermaid",
    name: string,
  ): Promise<void> {
    await test.step(`Click "${name}" on the rendered ${kind} block`, async () => {
      await this.previewBlockControl(kind, name).click();
    });
  }

  /** Open a mermaid block's download menu and download the diagram source. */
  async downloadMermaidSource(): Promise<Download> {
    return await test.step("Download the mermaid diagram as MMD", async () => {
      await this.clickPreviewBlockControl("mermaid", "Download diagram");
      const download = this.page.waitForEvent("download");
      // The menu item's text ("MMD") is its accessible name; its title only
      // describes it.
      await this.previewBlockControl("mermaid", "MMD").click();
      return await download;
    });
  }

  /** Close Streamdown's fullscreen diagram view. */
  async exitFullscreen(): Promise<void> {
    await test.step("Exit the fullscreen diagram", async () => {
      await this.fullscreenExitButton.click();
    });
  }

  /** The system clipboard's text. Needs the clipboard-read permission. */
  async readClipboard(): Promise<string> {
    return await this.page.evaluate(() => navigator.clipboard.readText());
  }

  /** The checkbox the preview renders for the task-list item `text`. */
  taskCheckbox(text: string): Locator {
    return this.previewFormatted("listitem", text).getByRole("checkbox");
  }

  /** Put the cursor at the end of the markdown preview's document. Clicks the
   *  editable surface (CodeMirror reports role="textbox") and presses the
   *  doc-end binding: Cmd+Down on macOS, Ctrl+End elsewhere. */
  async focusPreviewEnd(): Promise<void> {
    await test.step("Put the cursor at the end of the markdown preview", async () => {
      // Table cells are textboxes too; the editor's own content element
      // contains them, so it comes first in document order.
      await this.markdownPreview.getByRole("textbox").first().click();
      await this.page.keyboard.press(
        process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
      );
    });
  }

  /** Type into the focused preview. Each `\n` in `text` is an Enter press, so
   *  the markdown keymap (list continuation) runs the way it does for a user. */
  async typeInPreview(text: string): Promise<void> {
    await test.step(`Type into the markdown preview: ${JSON.stringify(text)}`, async () => {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await this.page.keyboard.press("Enter");
        if (lines[i]) await this.page.keyboard.type(lines[i]);
      }
    });
  }

  /** Save the focused editor with Cmd/Ctrl+S. */
  async saveWithShortcut(): Promise<void> {
    await test.step("Save with Cmd/Ctrl+S", async () => {
      await this.page.keyboard.press("ControlOrMeta+s");
    });
  }

  /** Assert (auto-retrying) that the file viewer is mounted and visible.
   *  Used for previews (e.g. markdown) that render outside the CodeMirror
   *  `.cm-content` surface, where `expectContent` doesn't apply. */
  async expectVisible(): Promise<void> {
    await test.step("File viewer is visible", async () => {
      await expect(this.root).toBeVisible({ timeout: 15_000 });
    });
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

  /** Type `text` at the very start of the document without saving, so every
   *  existing line moves down. */
  async typeAtStart(text: string): Promise<void> {
    await test.step(`Type "${text.trim()}" at the start of the editor`, async () => {
      await this.editor.click();
      await this.page.keyboard.press(
        process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
      );
      await this.page.keyboard.type(text);
      await expect(this.editor).toContainText(text.trim(), { timeout: 15_000 });
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
