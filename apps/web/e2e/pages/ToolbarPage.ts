/**
 * Page object for the toolbar's overflow menu (`ToolbarButtons.tsx`). The menu
 * items have system-controlled names, so they are found by role and name.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ToolbarPage {
  private readonly overflowTrigger: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.overflowTrigger = page.getByTestId("repo-list__overflow-trigger");
  }

  /** Navigate to the dashboard root with the test token. */
  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await expect(this.overflowTrigger).toBeVisible();
    });
  }

  /** Opens the overflow menu, re-clicking the trigger until a menu item shows
   *  (a click before hydration is lost). */
  async openOverflowMenu(): Promise<void> {
    await test.step("Open the toolbar overflow menu", async () => {
      await expect(async () => {
        await this.overflowTrigger.click();
        await expect(this.page.getByRole("menuitem").first()).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
    });
  }

  /** An entry of the open overflow menu, by its accessible name. */
  overflowMenuItem(name: string): Locator {
    return this.page.getByRole("menuitem", { name });
  }
}
