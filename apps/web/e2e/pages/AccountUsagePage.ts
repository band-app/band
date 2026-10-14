/**
 * Page object for the account usage popover in the repo-list bottom action
 * bar (`AccountUsagePopover.tsx`) and the icon-only Settings button next to it.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class AccountUsagePage {
  readonly settingsButton: Locator;
  readonly usageButton: Locator;
  readonly highestPercent: Locator;
  readonly popover: Locator;
  readonly settingsTooltip: Locator;
  readonly refreshButton: Locator;
  readonly problems: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.settingsButton = page.getByRole("button", { name: "Settings" });
    this.usageButton = page.getByRole("button", { name: "Account limits" });
    this.highestPercent = page.getByTestId("repo-list__account-usage-percent");
    this.popover = page.getByTestId("account-usage__popover");
    this.settingsTooltip = page.getByRole("tooltip", { name: "Settings" });
    this.refreshButton = page.getByRole("button", { name: "Refresh usage" });
    this.problems = page.getByTestId("account-usage__problem");
  }

  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await expect(this.usageButton).toBeVisible();
    });
  }

  /** The row of one provider. */
  row(provider: "claude" | "codex"): Locator {
    return this.page.getByTestId(`account-usage__row-${provider}`);
  }

  /** The bar of one window inside a row, found by its accessible name. */
  bar(provider: string, label: string): Locator {
    return this.popover.getByRole("progressbar", { name: `${provider} ${label}` });
  }

  async open(): Promise<void> {
    await test.step("Open the usage popover", async () => {
      await expect(this.usageButton).toBeVisible();
      await this.usageButton.click();
      await expect(this.popover).toBeVisible();
    });
  }

  async refresh(): Promise<void> {
    await test.step("Click Refresh in the usage popover", async () => {
      await this.refreshButton.click();
    });
  }
}
