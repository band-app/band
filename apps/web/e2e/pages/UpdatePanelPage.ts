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
    return this.panel
      .getByTestId("update-panel__host")
      .and(this.page.locator(`[data-host-id="${hostId}"]`));
  }

  /** The dashboard behind the badge has loaded. */
  async expectDashboardLoaded(): Promise<void> {
    await expect(this.page.getByTestId("repo-list__settings-button")).toBeVisible();
  }

  hubVersion(): Locator {
    return this.hubRow().getByTestId("update-panel__hub-version");
  }

  hubTarget(): Locator {
    return this.hubRow().getByTestId("update-panel__hub-target");
  }

  hubCommand(): Locator {
    return this.hubRow().getByTestId("update-panel__hub-command");
  }

  workerVersion(hostId: string): Locator {
    return this.workerRow(hostId).getByTestId("update-panel__host-version");
  }

  workerTarget(hostId: string): Locator {
    return this.workerRow(hostId).getByTestId("update-panel__host-target");
  }

  workerError(hostId: string): Locator {
    return this.workerRow(hostId).getByTestId("update-panel__host-error");
  }

  workerManualCommand(hostId: string): Locator {
    return this.workerRow(hostId).getByTestId("update-panel__host-manual-command");
  }

  updateButton(hostId: string): Locator {
    return this.workerRow(hostId).getByTestId("update-worker__button");
  }

  /** The version line of a host on Settings > Hosts, and its behind/unknown marker. */
  hostsVersion(hostRow: Locator): Locator {
    return hostRow.getByTestId("settings__host-version");
  }

  hostsVersionState(hostRow: Locator): Locator {
    return hostRow.getByTestId("settings__host-version-state");
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
  async clickUpdate(hostId: string): Promise<void> {
    await test.step("Click Update", async () => {
      await this.updateButton(hostId).click();
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

  /** Admin controls under the hub row (`HubUpdateControls.tsx`, `UpdateAllWorkers.tsx`). */
  hubUpdateButton(): Locator {
    return this.panel.getByTestId("hub-update__button");
  }

  hubUpdateError(): Locator {
    return this.panel.getByTestId("hub-update__error");
  }

  async setHubUpdateCommand(command: string): Promise<void> {
    await test.step("Save the hub update command", async () => {
      await this.panel.getByTestId("hub-update__command").fill(command);
      await this.panel.getByTestId("hub-update__save").click();
      await expect(this.hubUpdateButton()).toBeVisible();
    });
  }

  async clickUpdateHub(): Promise<void> {
    await this.hubUpdateButton().click();
  }

  hubUpdateDialog(): Locator {
    return this.page.getByTestId("hub-update__dialog");
  }

  hubUpdateAgents(): Locator {
    return this.page.getByTestId("hub-update__agent");
  }

  async confirmHubUpdate(): Promise<void> {
    await this.page.getByTestId("hub-update__confirm").click();
  }

  updateAllButton(): Locator {
    return this.panel.getByTestId("update-all__button");
  }

  updateAllResult(hostId: string): Locator {
    return this.panel
      .getByTestId("update-all__result")
      .and(this.page.locator(`[data-host-id="${hostId}"]`));
  }
}
