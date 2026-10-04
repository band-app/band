/**
 * Page object for a workspace that is waiting for a host (plan step 3.3).
 *
 * The cards sit in the project list under their project. Locators use the
 * `provisioning-workspace__*` test ids set in `ProvisioningWorkspaceCard.tsx`.
 */

import type { Locator, Page } from "@playwright/test";

export class ProvisioningPage {
  constructor(private readonly page: Page) {}

  /** The card for the workspace created on `branch`. */
  card(branch: string): Locator {
    // The branch is runtime data the test chose, so it is matched by text.
    return this.page
      .getByTestId("provisioning-workspace__card")
      .filter({ has: this.page.getByText(branch, { exact: true }) });
  }

  status(branch: string): Locator {
    return this.card(branch).getByTestId("provisioning-workspace__status");
  }

  error(branch: string): Locator {
    return this.card(branch).getByTestId("provisioning-workspace__error");
  }

  /** Cancels the wait, or dismisses a failed card. */
  async cancel(branch: string): Promise<void> {
    await this.card(branch).getByTestId("provisioning-workspace__cancel").click();
  }
}
