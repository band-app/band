/**
 * Page object for Settings > Hub in the desktop app: the picker that chooses
 * the local hub or a remote one.
 */

import { type Locator, type Page, test } from "@playwright/test";

export class HubPickerPage {
  readonly dialog: Locator;
  readonly mode: Locator;
  readonly url: Locator;
  readonly token: Locator;
  readonly apply: Locator;
  readonly error: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByRole("dialog", { name: "Settings" });
    this.mode = page.getByTestId("settings__hub-mode");
    this.url = page.getByTestId("settings__hub-url");
    this.token = page.getByTestId("settings__hub-token");
    this.apply = page.getByTestId("settings__hub-apply");
    this.error = page.getByTestId("settings__hub-error");
  }

  async open(): Promise<void> {
    await test.step("Open Settings > Hub", async () => {
      // The native menu's Cmd+, calls this global. The sidebar's Settings
      // button can sit under the center panel in a small window (CI runners).
      await this.page.evaluate(() => {
        (window as unknown as { __bandOpenSettings?: () => void }).__bandOpenSettings?.();
      });
      await this.dialog.waitFor({ state: "visible" });
      await this.mode.waitFor({ state: "visible" });
    });
  }

  async chooseRemote(url: string, token: string): Promise<void> {
    await test.step(`Choose the remote hub ${url}`, async () => {
      await this.mode.selectOption("remote");
      await this.url.fill(url);
      await this.token.fill(token);
      await this.apply.click();
    });
  }

  async chooseLocal(): Promise<void> {
    await test.step("Choose the local hub", async () => {
      await this.mode.selectOption("local");
      await this.apply.click();
    });
  }
}
