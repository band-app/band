/**
 * Page object for a worktree that is waiting for a host (plan step 3.3).
 *
 * The cards sit in the repo list under their repo. Locators use the
 * `provisioning-worktree__*` test ids set in `ProvisioningWorktreeCard.tsx`.
 */

import type { Locator, Page } from "@playwright/test";

export class ProvisioningPage {
  constructor(private readonly page: Page) {}

  /** The card for the worktree created on `branch`. */
  card(branch: string): Locator {
    // The branch is runtime data the test chose, so it is matched by text.
    return this.page
      .getByTestId("provisioning-worktree__card")
      .filter({ has: this.page.getByText(branch, { exact: true }) });
  }

  status(branch: string): Locator {
    return this.card(branch).getByTestId("provisioning-worktree__status");
  }

  error(branch: string): Locator {
    return this.card(branch).getByTestId("provisioning-worktree__error");
  }

  /** Cancels the wait, or dismisses a failed card. */
  async cancel(branch: string): Promise<void> {
    await this.card(branch).getByTestId("provisioning-worktree__cancel").click();
  }
}
