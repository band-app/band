/**
 * Page object for the "update available" badge in the sidebar footer, the update panel it opens,
 * and the Update button with its confirm dialog (on the panel and on Settings > Hosts). The
 * `data-testid`s are set in `UpdateAvailableBadge.tsx`, `UpdatePanelDialog.tsx`,
 * `WorkerUpdateButton.tsx`, `CopyCommand.tsx` and `HostVersionLine.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class UpdatePanelPage {
  readonly badge: Locator;
  readonly panel: Locator;
  readonly confirmDialog: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.badge = page.getByTestId("repo-list__update-badge");
    this.panel = page.getByTestId("update-panel");
    this.confirmDialog = page.getByTestId("update-worker__dialog");
  }

  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
    });
  }

  async openPanel(): Promise<void> {
    await test.step("Open the update panel from the badge", async () => {
      await this.badge.click();
      await expect(this.panel).toBeVisible();
    });
  }

  hubRow(): Locator {
    return this.panel.getByTestId("update-panel__hub");
  }

  workerRow(hostId: string): Locator {
    return this.panel.locator(`[data-testid="update-panel__host"][data-host-id="${hostId}"]`);
  }

  /** Copies the hub command with its button and returns what the clipboard holds. */
  async copyHubCommand(): Promise<string> {
    return test.step("Copy the hub update command", async () => {
      await this.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await this.panel.getByTestId("update-panel__hub-copy").click();
      return this.page.evaluate(() => navigator.clipboard.readText());
    });
  }

  /** Clicks Update on a worker's panel row, which opens the confirm dialog. */
  async clickUpdate(row: Locator): Promise<void> {
    await test.step("Click Update", async () => {
      await row.getByTestId("update-worker__button").click();
      await expect(this.confirmDialog).toBeVisible();
    });
  }

  async confirmUpdate(): Promise<void> {
    await test.step("Confirm the update", async () => {
      await this.confirmDialog.getByTestId("update-worker__confirm").click();
    });
  }

  confirmError(): Locator {
    return this.confirmDialog.getByTestId("update-worker__error");
  }

  /** The agents the confirm dialog says the restart will interrupt. */
  confirmAgents(): Locator {
    return this.confirmDialog.getByTestId("update-worker__agents");
  }

  async cancelUpdate(): Promise<void> {
    await this.confirmDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(this.confirmDialog).toBeHidden();
  }
}
