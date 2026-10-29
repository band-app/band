/**
 * Page object for the "Install band CLI" banner in the dashboard shell. The `data-testid`s are
 * set in `DashboardShell.tsx`.
 */

import { type Locator, type Page, test } from "@playwright/test";

export class CliBannerPage {
  readonly banner: Locator;
  readonly message: Locator;
  readonly installButton: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.banner = page.getByTestId("cli-banner");
    this.message = page.getByTestId("cli-banner__message");
    this.installButton = page.getByTestId("cli-banner__install");
  }

  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
    });
  }

  async install(): Promise<void> {
    await test.step("Click Install", async () => {
      await this.installButton.click();
    });
  }

  /** The window regaining focus, as when a person comes back from fixing it in a terminal. */
  async regainFocus(): Promise<void> {
    await test.step("Window regains focus", async () => {
      await this.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    });
  }
}
