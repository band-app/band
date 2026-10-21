/**
 * Page object for the HTML file viewer's Visual mode: the page in a sandboxed
 * iframe with click-to-edit text.
 *
 * The frame holds the page under test, so its content is reached through
 * `frameLocator` with role queries. Secondary page object: it owns no routes.
 */

import { expect, type FrameLocator, type Locator, type Page, test } from "@playwright/test";

export class HtmlVisualPage {
  constructor(private readonly page: Page) {}

  get visualButton(): Locator {
    return this.page.getByTestId("center-file-leaf__view--preview");
  }

  get sourceButton(): Locator {
    return this.page.getByTestId("center-file-leaf__view--source");
  }

  get notice(): Locator {
    return this.page.getByTestId("html-visual__notice");
  }

  get frameElement(): Locator {
    return this.page.getByTestId("html-visual__frame");
  }

  get frame(): FrameLocator {
    return this.page.frameLocator('[data-testid="html-visual__frame"]');
  }

  async openVisual(): Promise<void> {
    await test.step("Switch to Visual mode", async () => {
      await this.visualButton.click();
      await expect(this.frameElement).toBeVisible();
    });
  }

  /** Click the element, replace its text and press Enter. */
  async replaceText(target: Locator, text: string): Promise<void> {
    await test.step(`Replace text with ${JSON.stringify(text)}`, async () => {
      await target.click();
      await expect(target).toHaveAttribute("contenteditable", /true|plaintext-only/);
      await this.page.keyboard.press("ControlOrMeta+a");
      await this.page.keyboard.insertText(text);
      await this.page.keyboard.press("Enter");
    });
  }

  /** Click the element, type extra text and press Escape. */
  async typeThenCancel(target: Locator, text: string): Promise<void> {
    await test.step("Type then press Escape", async () => {
      await target.click();
      await expect(target).toHaveAttribute("contenteditable", /true|plaintext-only/);
      await this.page.keyboard.insertText(text);
      await this.page.keyboard.press("Escape");
    });
  }

  /** Post a commit message from inside the page with a nonce the parent did not issue. */
  async postForgedCommitFromPage(range: { start: number; end: number }): Promise<void> {
    await this.frame.locator("body").evaluate((_body, r) => {
      window.parent.postMessage(
        {
          type: "band-visual-edit:commit",
          nonce: "not-the-nonce",
          start: r.start,
          end: r.end,
          oldText: "x",
          newText: "forged",
        },
        "*",
      );
    }, range);
  }

  /** Post a commit message from the Band page itself, which is not the iframe's window. */
  async postForgedCommitFromParent(nonce: string | null, range: { start: number; end: number }) {
    await this.page.evaluate(
      ({ nonce: n, r }) => {
        window.postMessage(
          {
            type: "band-visual-edit:commit",
            nonce: n,
            start: r.start,
            end: r.end,
            oldText: "x",
            newText: "forged",
          },
          "*",
        );
      },
      { nonce, r: range },
    );
  }

  /** The nonce the Band page put in the iframe's URL. */
  async frameNonce(): Promise<string | null> {
    const src = await this.frameElement.getAttribute("src");
    return src ? new URL(src, "http://x").searchParams.get("band-edit") : null;
  }
}
