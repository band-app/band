/**
 * Page object for "this computer as a worker" in the desktop app: the first-run prompt and the
 * "This computer" section of Settings > Hosts.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ThisComputerPage {
  readonly prompt: Locator;
  readonly promptName: Locator;
  readonly promptYes: Locator;
  readonly promptNotNow: Locator;
  readonly promptError: Locator;
  readonly settings: Locator;
  readonly state: Locator;
  readonly add: Locator;
  readonly remove: Locator;
  readonly switchToBundled: Locator;
  readonly localHubNote: Locator;
  readonly dialog: Locator;

  constructor(private readonly page: Page) {
    this.prompt = page.getByTestId("this-computer-prompt");
    this.promptName = page.getByTestId("this-computer-prompt__name");
    this.promptYes = page.getByTestId("this-computer-prompt__yes");
    this.promptNotNow = page.getByTestId("this-computer-prompt__not-now");
    this.promptError = page.getByTestId("this-computer-prompt__error");
    this.settings = page.getByTestId("this-computer");
    this.state = page.getByTestId("this-computer__state");
    this.add = page.getByTestId("this-computer__add");
    this.remove = page.getByTestId("this-computer__remove");
    this.switchToBundled = page.getByTestId("this-computer__switch");
    this.localHubNote = page.getByTestId("this-computer__local-hub");
    this.dialog = page.getByRole("dialog", { name: "Settings" });
  }

  async openHostsSettings(): Promise<void> {
    await test.step("Open Settings > Hosts", async () => {
      // The global exists once the dashboard has mounted, so ask again until the dialog is up.
      await expect(async () => {
        await this.page.evaluate(() => {
          (window as unknown as { __bandOpenSettings?: () => void }).__bandOpenSettings?.();
        });
        await expect(this.dialog).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
      await this.dialog.getByTestId("settings__nav-hosts").click();
      await expect(this.settings).toBeVisible();
    });
  }
}
