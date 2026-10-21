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

  get editToggle(): Locator {
    return this.page.getByTestId("center-file-leaf__html-edit");
  }

  async turnOnEditText(): Promise<void> {
    await test.step("Turn on Edit text", async () => {
      await this.editToggle.click();
      await expect(this.editToggle).toHaveAttribute("aria-pressed", "true");
    });
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

  /** Set a flag on the page's window, to tell later whether the page was reloaded. */
  async markPage(): Promise<void> {
    await this.frame.locator("body").evaluate(() => {
      (window as unknown as { __bandMarked: boolean }).__bandMarked = true;
    });
  }

  async pageIsMarked(): Promise<boolean> {
    return this.frame
      .locator("body")
      .evaluate(() => (window as unknown as { __bandMarked?: boolean }).__bandMarked === true);
  }

  get commentBox(): Locator {
    return this.page.getByTestId("html-visual__comment");
  }

  get commentInput(): Locator {
    return this.page.getByTestId("html-visual__comment-input");
  }

  get commentSend(): Locator {
    return this.page.getByTestId("html-visual__comment-send");
  }

  /** Drag across the start of an element's text, as a person selects it with the mouse. */
  async dragSelect(target: Locator): Promise<void> {
    await test.step("Select text by dragging", async () => {
      const box = await target.boundingBox();
      if (!box) throw new Error("The element to select has no box");
      const y = box.y + box.height / 2;
      await this.page.mouse.move(box.x + 3, y);
      await this.page.mouse.down();
      await this.page.mouse.move(box.x + 70, y, { steps: 6 });
      await this.page.mouse.up();
    });
  }

  /** Alt+click an element to comment on it, whatever it holds. */
  async altClick(target: Locator): Promise<void> {
    await test.step("Alt+click the element", async () => {
      await target.click({ modifiers: ["Alt"] });
    });
  }

  async sendComment(text: string): Promise<void> {
    await test.step(`Send the comment ${JSON.stringify(text)}`, async () => {
      await expect(this.commentBox).toBeVisible();
      await this.commentInput.fill(text);
      await this.commentSend.click();
    });
  }
}
