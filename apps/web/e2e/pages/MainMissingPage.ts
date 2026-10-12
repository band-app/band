/**
 * Page object for the sidebar row that stands in for a repo's default branch when no host has it
 * checked out (`MainMissingRow.tsx`). Test bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class MainMissingPage {
  constructor(private readonly page: Page) {}

  /** The row, which names the primary host whose clone is not on the default branch. */
  row(): Locator {
    return this.page.getByTestId("repo-main-missing");
  }

  text(): Locator {
    return this.row().getByTestId("repo-main-missing__text");
  }

  makePrimaryButton(hostId: string): Locator {
    return this.row().locator(
      `[data-testid="repo-main-missing__make-primary"][data-host-id="${hostId}"]`,
    );
  }

  async makePrimary(hostId: string): Promise<void> {
    await test.step(`Make ${hostId} the primary host from the sidebar row`, async () => {
      await this.makePrimaryButton(hostId).click();
      await expect(this.row()).toHaveCount(0);
    });
  }
}
