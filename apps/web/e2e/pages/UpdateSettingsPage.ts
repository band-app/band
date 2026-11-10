/**
 * Page object for the update controls in Settings > Hub and on each Settings > Workers row. Both
 * use `UpdateControls.tsx`; a worker's controls are in its drawer. The test ids come
 * from `UpdateControls.tsx` (`<prefix>__latest`, `__check`, `__blocked`; the switch is found by its name) with the
 * prefix `hub-update` for the hub and `worker-update` for a worker row.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export class UpdateSettingsPage {
  readonly settings: SettingsPage;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.settings = new SettingsPage(page);
  }

  async openHub(): Promise<void> {
    await test.step("Open Settings > Hub", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
      await this.settings.openDialog("hub");
      await expect(this.hubControls()).toBeVisible();
    });
  }

  async openWorkers(): Promise<void> {
    await test.step("Open Settings > Workers", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
      await this.settings.openDialog("hosts");
    });
  }

  hubControls(): Locator {
    return this.settings.dialog.getByTestId("hub-update");
  }

  hubVersion(): Locator {
    return this.hubControls().getByTestId("hub-update__version");
  }

  hubLatest(): Locator {
    return this.hubControls().getByTestId("hub-update__latest");
  }

  hubCheck(): Locator {
    return this.hubControls().getByTestId("hub-update__check");
  }

  hubAuto(): Locator {
    return this.hubControls().getByRole("switch", { name: "Update the hub automatically" });
  }

  hubBlocked(): Locator {
    return this.hubControls().getByTestId("hub-update__blocked");
  }

  /** The row of one worker on Settings > Workers, found by its name. */
  workerRow(name: string): Locator {
    return this.page.getByTestId("settings__host").filter({ hasText: name });
  }

  /** The drawer of the open worker. Call `openWorker` first. */
  workerDrawer(): Locator {
    return this.settings.hostDrawer();
  }

  /** Opens the drawer of a worker by its name (closing another one first). */
  async openWorker(name: string): Promise<Locator> {
    await this.settings.closeHostDrawer();
    await this.workerRow(name).getByTestId("settings__host-name").click();
    await expect(this.workerDrawer().getByTestId("settings__host-drawer-name")).toHaveText(name);
    return this.workerDrawer();
  }

  workerAuto(name: string): Locator {
    return this.workerDrawer().getByRole("switch", { name: `Update ${name} automatically` });
  }

  workerAutoNote(): Locator {
    return this.workerDrawer().getByTestId("worker-update__auto-note");
  }

  workerBlocked(): Locator {
    return this.workerDrawer().getByTestId("worker-update__blocked");
  }

  workerUpdateButton(): Locator {
    return this.workerDrawer().getByTestId("update-worker__button");
  }

  /** The version cell of a worker row. */
  workerVersion(name: string): Locator {
    return this.workerRow(name).getByTestId("settings__host-version");
  }

  /** The page's "Check for updates" button. There is one for the whole page. */
  checkButtons(): Locator {
    return this.page.getByRole("button", { name: "Check for updates" });
  }

  async toggle(switchLocator: Locator, on: boolean): Promise<void> {
    await test.step(`Turn the switch ${on ? "on" : "off"}`, async () => {
      await expect(switchLocator).toBeEnabled();
      if ((await switchLocator.isChecked()) !== on) await switchLocator.click();
      if (on) await expect(switchLocator).toBeChecked();
      else await expect(switchLocator).not.toBeChecked();
    });
  }

  async reload(): Promise<void> {
    await this.page.reload();
    await this.page.waitForLoadState("networkidle");
  }
}
