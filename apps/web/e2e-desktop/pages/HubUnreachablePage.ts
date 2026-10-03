/**
 * Page object for the page the desktop window shows when the saved remote hub
 * does not answer at launch.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class HubUnreachablePage {
  readonly title: Locator;
  readonly reason: Locator;
  readonly retry: Locator;
  readonly useLocal: Locator;

  constructor(private readonly page: Page) {
    this.title = page.getByTestId("hub-unreachable__title");
    this.reason = page.getByTestId("hub-unreachable__reason");
    this.retry = page.getByTestId("hub-unreachable__retry");
    this.useLocal = page.getByTestId("hub-unreachable__use-local");
  }

  async expectShown(): Promise<void> {
    await test.step("The unreachable-hub page is shown", async () => {
      await expect(this.title).toBeVisible();
      await expect(this.retry).toBeVisible();
      await expect(this.useLocal).toBeVisible();
    });
  }

  async expectReasonShown(): Promise<void> {
    await test.step("The reason is shown", async () => {
      await expect(this.reason).toBeVisible();
      await expect(this.reason).not.toBeEmpty();
    });
  }

  async clickRetry(): Promise<void> {
    await test.step("Click Retry", async () => {
      await this.retry.click();
    });
  }

  async clickUseLocal(): Promise<void> {
    await test.step("Click Use local", async () => {
      await this.useLocal.click();
    });
  }
}
