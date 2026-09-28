/**
 * Component page object for the right-click menu on a text selection
 * (`SelectionContextMenu.tsx`): the CodeMirror menu of the file editor, the
 * file viewer and both sides of a diff, and the terminal menu. Both render the
 * same `selection-menu__*` test ids.
 *
 * This is a SECONDARY page object: it owns no route and constructs no URL, so
 * it does not follow the `(page, baseUrl, …)` + `goto()` convention. The
 * editor methods take the element that holds the CodeMirror view (a file
 * leaf, or one side of a diff) from the page object that owns it. Terminal
 * selection lives on `TerminalInputSurface`, which knows the cell grid.
 *
 * FRAGILITY: `.cm-line` is CodeMirror-owned DOM with no test hook of its own
 * (same caveat as `ChangesPanelPage`). The lines are found by the text the
 * spec seeded.
 */

import { type Locator, type Page, test } from "@playwright/test";

export type SelectionMenuItem =
  | "add-to-chat"
  | "add-to-terminal"
  | "copy-reference"
  | "cut"
  | "copy"
  | "paste"
  | "select-all";

export class SelectionMenu {
  readonly root: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByTestId("selection-menu");
  }

  item(name: SelectionMenuItem): Locator {
    return this.page.getByTestId(`selection-menu__${name}`);
  }

  /** The shortcut hint shown on an item. */
  shortcut(name: SelectionMenuItem): Locator {
    return this.page.getByTestId(`selection-menu__${name}-shortcut`);
  }

  /** The CodeMirror line in `editor` whose text is exactly `text`. */
  private line(editor: Locator, text: string): Locator {
    return editor.locator(".cm-line").getByText(text, { exact: true }).first();
  }

  /** Double-click `word`, a line of its own, to select it. Clicks near the
   *  line's start so the pointer is on the word, not the empty space after. */
  async selectWordInEditor(editor: Locator, word: string): Promise<void> {
    await test.step(`Select "${word}" in the editor`, async () => {
      const line = this.line(editor, word);
      await line.waitFor({ state: "visible", timeout: 15_000 });
      await line.dblclick({ position: { x: 4, y: 6 } });
    });
  }

  /** Right-click `word` (a line of its own) to open the menu. */
  async openOnEditorWord(editor: Locator, word: string): Promise<void> {
    await test.step(`Right-click "${word}" in the editor`, async () => {
      await this.line(editor, word).click({ button: "right", position: { x: 4, y: 6 } });
    });
  }

  /** Click the empty space right of `lineText` to drop the selection, then
   *  right-click there. */
  async openOnEditorBlank(editor: Locator, lineText: string): Promise<void> {
    await test.step(`Right-click past the end of "${lineText}" with nothing selected`, async () => {
      const line = this.line(editor, lineText);
      const box = await line.boundingBox();
      if (!box) throw new Error(`line "${lineText}" is not rendered`);
      const position = { x: box.width - 4, y: box.height / 2 };
      await line.click({ position });
      await line.click({ button: "right", position });
    });
  }

  /** The text selected in the CodeMirror view inside `editor`, read from the
   *  page's DOM selection (CodeMirror mirrors its selection into it). */
  async readEditorSelection(editor: Locator): Promise<string> {
    return await editor.evaluate((el) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return "";
      return el.contains(sel.anchorNode) ? sel.toString() : "";
    });
  }

  /** How many popups (a CodeMirror tooltip, or this menu) appeared on the page
   *  during the next `ms` milliseconds. The old selection tooltip showed 500 ms
   *  after a selection settled, so a window longer than that catches it
   *  coming back. `.cm-tooltip` is CodeMirror-owned DOM (see the header). */
  async countPopupsDuring(ms: number): Promise<number> {
    return await this.page.evaluate(
      (windowMs) =>
        new Promise<number>((resolve) => {
          const selector = '.cm-tooltip, [data-testid="selection-menu"]';
          let count = document.querySelectorAll(selector).length;
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches(selector)) count++;
                count += node.querySelectorAll(selector).length;
              }
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(count);
          }, windowMs);
        }),
      ms,
    );
  }

  /** Dismiss the open menu without choosing anything. */
  async close(): Promise<void> {
    await test.step("Close the selection menu", async () => {
      await this.page.keyboard.press("Escape");
      await this.root.waitFor({ state: "hidden" });
    });
  }

  async choose(name: SelectionMenuItem): Promise<void> {
    await test.step(`Choose "${name}" in the selection menu`, async () => {
      await this.item(name).click();
    });
  }
}
