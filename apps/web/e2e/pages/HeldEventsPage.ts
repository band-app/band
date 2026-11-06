/**
 * Page object for the notice above a chat that continued on another worker while its old worker
 * kept logging events: the text, View (read-only transcript) and Discard. Locators use the test
 * ids set in `HeldEventsNotice.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class HeldEventsPage {
  constructor(private readonly page: Page) {}

  get notice(): Locator {
    return this.page.getByTestId("held-events").filter({ visible: true });
  }

  get text(): Locator {
    return this.notice.getByTestId("held-events__text");
  }

  get transcriptLines(): Locator {
    return this.page.getByTestId("held-events__line");
  }

  async view(): Promise<void> {
    await test.step("View the held events", async () => {
      await this.notice.getByTestId("held-events__view").click();
      await expect(this.page.getByTestId("held-events__dialog")).toBeVisible();
    });
  }

  async closeView(): Promise<void> {
    await test.step("Close the held events", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.page.getByTestId("held-events__dialog")).toBeHidden();
    });
  }

  async discard(): Promise<void> {
    await test.step("Discard the held events", async () => {
      await this.notice.getByTestId("held-events__discard").click();
    });
  }
}
