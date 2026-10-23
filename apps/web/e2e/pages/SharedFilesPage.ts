/**
 * Page object for the files an agent shares: the cards in the chat and the
 * center tab a card opens. Locators use `data-testid`s from `message.tsx` and
 * `SharedFileLeaf.tsx`. The tab's test id is `center-file-tab--shared:<chatId>/<name>`,
 * and a spec does not know the chat id, so tabs are found by their file name.
 */

import { type Download, expect, type Locator, type Page, test } from "@playwright/test";

export class SharedFilesPage {
  readonly viewer: Locator;
  readonly image: Locator;
  readonly pdf: Locator;
  readonly html: Locator;
  readonly markdown: Locator;
  readonly code: Locator;
  readonly binary: Locator;
  readonly viewerDownload: Locator;

  constructor(private readonly page: Page) {
    const visible = (id: string) => page.getByTestId(id).filter({ visible: true });
    this.viewer = visible("shared-file");
    this.image = visible("shared-file__image");
    this.pdf = visible("shared-file__pdf");
    this.html = visible("shared-file__html");
    this.markdown = visible("shared-file__markdown");
    this.code = visible("shared-file__code");
    this.binary = visible("shared-file__binary");
    this.viewerDownload = visible("shared-file__download");
  }

  /** The chat card of a shared file. */
  card(name: string): Locator {
    return this.page
      .getByTestId("message__file-card")
      .filter({ hasText: name })
      .or(
        this.page
          .getByTestId("message__file-card")
          .filter({ has: this.page.getByRole("img", { name }) }),
      );
  }

  /** Brings the chat tab back to the front, where the cards are. */
  async showChat(): Promise<void> {
    await this.page
      .getByTestId(/^center-chat-tab--/)
      .filter({ visible: true })
      .first()
      .click();
  }

  /** The center tab showing a shared file. */
  tab(name: string): Locator {
    return this.page.getByTestId(
      new RegExp(`^center-file-tab--shared:[^/]*/${name.replace(/\./g, "\\.")}$`),
    );
  }

  async openCard(name: string): Promise<void> {
    await test.step(`Open the card for ${name}`, async () => {
      await this.showChat();
      await this.card(name)
        .locator(
          '[data-testid="message__file-card-open"], [data-testid="message__image-preview-button"]',
        )
        .click();
      await expect(this.tab(name)).toBeVisible();
    });
  }

  async downloadFromCard(name: string): Promise<Download> {
    return await test.step(`Download ${name} from its card`, async () => {
      await this.showChat();
      const pending = this.page.waitForEvent("download");
      await this.card(name).getByTestId("message__file-card-download").click();
      return await pending;
    });
  }
}
