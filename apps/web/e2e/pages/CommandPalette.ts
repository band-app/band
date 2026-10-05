/**
 * Component object for the command palette
 * (`apps/web/src/dashboard/components/CommandPaletteDialog.tsx`), opened with
 * ⇧⌘P (Ctrl+Shift+P off macOS).
 *
 * Locators key off `data-testid` hooks the component sets:
 *   - `command-palette`                     — the dialog content
 *   - `command-palette__item--<id>`         — a command row (id from
 *     `command-registry.ts`)
 *   - `command-palette__shortcut--<id>`     — that row's shortcut hint
 *
 * A component object like `WorktreePicker`: the dialog has no URL of its own,
 * so it takes only `page`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class CommandPalette {
  readonly dialog: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByTestId("command-palette");
  }

  item(commandId: string): Locator {
    return this.page.getByTestId(`command-palette__item--${commandId}`);
  }

  shortcut(commandId: string): Locator {
    return this.page.getByTestId(`command-palette__shortcut--${commandId}`);
  }

  /** Open the palette with ⇧⌘P (Ctrl+Shift+P off macOS). */
  async open(): Promise<void> {
    await test.step("Open the command palette (⇧⌘P)", async () => {
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await this.page.keyboard.press(`${modifier}+Shift+p`);
    });
  }

  /** Run a command by clicking its row. */
  /** Close the palette with Escape. */
  async close(): Promise<void> {
    await test.step("Close the command palette", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.dialog).toBeHidden();
    });
  }

  async run(commandId: string): Promise<void> {
    await test.step(`Run palette command ${commandId}`, async () => {
      await this.item(commandId).click();
    });
  }
}
