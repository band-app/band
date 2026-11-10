/**
 * Page object for the Updates and Connection cards of Settings > Hub. Test ids are set in
 * `HubUpdateCard.tsx` and `HubSettings.tsx`. The control names that come from `UpdateControls.tsx`
 * (`hub-update__check`, `__latest`, the switch) are shared with `UpdateSettingsPage`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export type HubUpdateState =
  | "up-to-date"
  | "available"
  | "updating"
  | "waiting"
  | "failed"
  | "blocked";

export class HubSettingsPage {
  readonly settings: SettingsPage;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.settings = new SettingsPage(page);
  }

  async open(): Promise<void> {
    await test.step("Open Settings > Hub", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
      await this.settings.openDialog("hub");
      await expect(this.statusLine()).toBeVisible();
    });
  }

  statusLine(): Locator {
    return this.page.getByTestId("hub-update__status");
  }

  headline(): Locator {
    return this.page.getByTestId("hub-update__headline");
  }

  summary(): Locator {
    return this.page.getByTestId("hub-update__summary");
  }

  updateNow(): Locator {
    return this.page.getByTestId("hub-update__button");
  }

  retry(): Locator {
    return this.page.getByTestId("hub-update__retry");
  }

  errorIcon(): Locator {
    return this.page.getByTestId("hub-update__error-icon");
  }

  errorMessage(): Locator {
    return this.page.getByTestId("hub-update__error");
  }

  manualCommand(): Locator {
    return this.page.getByTestId("hub-update__manual-command");
  }

  lastResult(): Locator {
    return this.page.getByTestId("hub-update__last-result");
  }

  async openLog(): Promise<Locator> {
    await this.page.getByTestId("hub-update__view-log").click();
    const dialog = this.page.getByTestId("hub-update__log-dialog");
    await expect(dialog).toBeVisible();
    return dialog;
  }

  logText(): Locator {
    return this.page.getByTestId("hub-update__log");
  }

  backup(): Locator {
    return this.page.getByTestId("hub-update__backup");
  }

  advanced(): Locator {
    return this.page.getByTestId("hub-update__advanced");
  }

  async openAdvanced(): Promise<void> {
    await this.page.getByTestId("hub-update__advanced-toggle").click();
  }

  saveCommand(): Locator {
    return this.page.getByTestId("hub-update__save");
  }

  commandInput(): Locator {
    return this.page.getByRole("textbox", { name: "Custom update command" });
  }

  connection(): Locator {
    return this.page.getByTestId("settings__hub-connection");
  }

  connectionUrl(): Locator {
    return this.page.getByTestId("settings__hub-connection-url");
  }

  changeButton(): Locator {
    return this.page.getByTestId("settings__hub-change");
  }

  workersLine(): Locator {
    return this.page.getByTestId("hub-update__workers-line");
  }
}
