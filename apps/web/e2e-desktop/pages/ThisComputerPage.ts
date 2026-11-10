/**
 * Page object for "this computer as a worker" in the desktop app: the first-run prompt, the
 * "Add this Mac" row and the "This computer" row and drawer of Settings > Workers.
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

  /** Opens the "Add this Mac as a worker" form at the end of the Workers table. */
  async showAddForm(): Promise<void> {
    await test.step("Open the Add this Mac form", async () => {
      if (!(await this.add.isVisible())) await this.page.getByTestId("this-computer__open").click();
      await expect(this.add).toBeVisible();
    });
  }

  /** Opens the drawer of this Mac's worker, which holds Remove and Switch to the bundled worker. */
  async openDrawer(): Promise<void> {
    await test.step("Open the drawer of this computer", async () => {
      await expect(this.state).toBeVisible({ timeout: 60_000 });
      if (!(await this.page.getByTestId("this-computer-section").isVisible())) {
        await this.state.click();
      }
      await expect(this.page.getByTestId("this-computer-section")).toBeVisible();
    });
  }

  async openHostsSettings(): Promise<void> {
    await test.step("Open Settings > Workers", async () => {
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
