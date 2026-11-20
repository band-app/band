/**
 * Page object for Settings > Keyboard: the list of every registry command with its chord, and the
 * controls to record, clear and reset it. Recording presses real keys, like a person would.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export class KeyboardSettingsPage {
  readonly settings: SettingsPage;
  readonly root: Locator;
  readonly conflict: Locator;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.settings = new SettingsPage(page, baseUrl, token);
    this.root = this.settings.dialog.getByTestId("keyboard-settings");
    this.conflict = this.root.getByTestId("keyboard-settings__conflict");
  }

  /** Open the Keyboard page of the loaded app. */
  async open(): Promise<void> {
    await this.settings.openDialog("keyboard");
    await expect(this.root).toBeVisible();
  }

  async close(): Promise<void> {
    await test.step("Close Settings", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.settings.dialog).toBeHidden();
    });
  }

  row(commandId: string): Locator {
    return this.root.getByTestId(`keyboard-settings__row--${commandId}`);
  }

  chord(commandId: string): Locator {
    return this.root.getByTestId(`keyboard-settings__chord--${commandId}`);
  }

  /** Ids of the commands listed, top to bottom. */
  async commandIds(): Promise<string[]> {
    const ids = await this.root
      .locator('[data-testid^="keyboard-settings__row--"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
    return ids.map((t) => t.replace("keyboard-settings__row--", ""));
  }

  /** Click Change on a row and press the chord (a Playwright key string where `Mod` is the platform modifier, such as "Mod+Shift+KeyY"). */
  async record(commandId: string, chord: string): Promise<void> {
    await test.step(`Record ${chord} for ${commandId}`, async () => {
      await this.root.getByTestId(`keyboard-settings__change--${commandId}`).click();
      await expect(this.chord(commandId)).toHaveText("Press keys…");
      await this.page.keyboard.press(
        chord.replace(/\bMod\b/g, process.platform === "darwin" ? "Meta" : "Control"),
      );
    });
  }

  async clear(commandId: string): Promise<void> {
    await this.root.getByTestId(`keyboard-settings__clear--${commandId}`).click();
  }

  async reset(commandId: string): Promise<void> {
    await this.root.getByTestId(`keyboard-settings__reset--${commandId}`).click();
  }

  async resetAll(): Promise<void> {
    await this.root.getByTestId("keyboard-settings__reset-all").click();
  }

  async confirmConflict(): Promise<void> {
    await this.root.getByTestId("keyboard-settings__conflict-confirm").click();
  }

  async cancelConflict(): Promise<void> {
    await this.root.getByTestId("keyboard-settings__conflict-cancel").click();
  }

  async search(query: string): Promise<void> {
    await this.root.getByTestId("keyboard-settings__search").fill(query);
  }
}
