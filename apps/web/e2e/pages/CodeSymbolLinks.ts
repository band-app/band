/**
 * Component object for LSP go-to-definition in a CodeMirror editor: the
 * Cmd/Ctrl+hover link (`codemirror-lsp.ts` marks the symbol with
 * `cm-lsp-cmd-link`) and Cmd/Ctrl+Click.
 *
 * Shared by the file editor (`FileViewerPage`) and each side of a diff
 * (`ChangesPanelPage`), scoped to one editor's root so a link in another
 * editor on the page never matches.
 *
 * FRAGILITY: `.cm-line` is CodeMirror-owned DOM with no testid hook; it is
 * centralised here, the same caveat `ChangesPanelPage.diffLine` records.
 * `cm-lsp-cmd-link` is our own class (set in `codemirror-lsp.ts`).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class CodeSymbolLinks {
  /** The symbol currently shown as a Cmd/Ctrl+hover link. */
  readonly link: Locator;

  constructor(
    private readonly page: Page,
    private readonly scope: Locator,
  ) {
    this.link = scope.locator(".cm-lsp-cmd-link");
  }

  /** A rendered line of the editor, by text the fixture wrote. */
  line(text: string): Locator {
    return this.scope.locator(".cm-line").filter({ hasText: text }).first();
  }

  /** Screen centre of the first `word` inside the line containing `lineText`. */
  private async wordCentre(lineText: string, word: string): Promise<{ x: number; y: number }> {
    const line = this.line(lineText);
    await line.scrollIntoViewIfNeeded();
    const point = await line.evaluate((el, w) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let offset = el.textContent?.indexOf(w) ?? -1;
      if (offset < 0) return null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.textContent?.length ?? 0;
        if (offset < len) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, Math.min(offset + 1, len));
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        offset -= len;
      }
      return null;
    }, word);
    if (!point) throw new Error(`"${word}" not found in line "${lineText}"`);
    return point;
  }

  /** Hold Cmd/Ctrl and move the mouse onto `word` (then release the key). */
  async cmdHover(lineText: string, word: string): Promise<void> {
    await test.step(`Cmd/Ctrl+hover "${word}"`, async () => {
      const { x, y } = await this.wordCentre(lineText, word);
      await this.page.mouse.move(x, y + 40);
      await this.page.keyboard.down("ControlOrMeta");
      await this.page.mouse.move(x, y, { steps: 2 });
    });
  }

  /** Release Cmd/Ctrl after a `cmdHover`. */
  async releaseModifier(): Promise<void> {
    await this.page.keyboard.up("ControlOrMeta");
  }

  /** Cmd/Ctrl+Click `word`. */
  async cmdClick(lineText: string, word: string): Promise<void> {
    await test.step(`Cmd/Ctrl+click "${word}"`, async () => {
      const { x, y } = await this.wordCentre(lineText, word);
      await this.page.mouse.move(x, y);
      await this.page.keyboard.down("ControlOrMeta");
      await this.page.mouse.click(x, y);
      await this.page.keyboard.up("ControlOrMeta");
    });
  }

  /** Wait for the Cmd/Ctrl+hover link to show `word`. */
  async expectLinkOn(word: string): Promise<void> {
    await expect(this.link).toHaveText(word, { timeout: 15_000 });
  }

  /**
   * The computed text colour of the link and of every element inside it
   * (syntax highlighting nests coloured spans), plus the theme's `--link`
   * colour resolved the same way, for comparison.
   */
  async linkColours(): Promise<{ expected: string; actual: string[] }> {
    return await this.link.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--link)";
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      const actual = [el, ...Array.from(el.querySelectorAll("*"))].map(
        (node) => getComputedStyle(node).color,
      );
      return { expected, actual };
    });
  }
}
