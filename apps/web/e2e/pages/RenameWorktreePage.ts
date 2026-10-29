/**
 * Page object for renaming a worktree from its sidebar card: the "Rename…" context-menu item,
 * double-clicking the title, and the inline title field.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class RenameWorktreePage {
  constructor(private readonly page: Page) {}

  private card(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`).first();
  }

  /** The title (or name) a card shows. */
  title(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__title");
  }

  /** The inline text field, while a card is being renamed. */
  get input(): Locator {
    return this.page.getByTestId("worktree-card__title-input");
  }

  async renameFromMenu(worktreeId: string, title: string): Promise<void> {
    await test.step(`Rename ${worktreeId} to "${title}" from the context menu`, async () => {
      await this.card(worktreeId).click({ button: "right" });
      await this.page.getByTestId("worktree-card__rename").click();
      await expect(this.input).toBeFocused();
      await this.input.fill(title);
      await this.input.press("Enter");
    });
  }

  async startEditingByDoubleClick(worktreeId: string): Promise<void> {
    await test.step(`Double-click the title of ${worktreeId}`, async () => {
      await this.title(worktreeId).dblclick();
      await expect(this.input).toBeFocused();
    });
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async type(text: string): Promise<void> {
    await this.input.fill(text);
  }

  async press(key: string): Promise<void> {
    await this.input.press(key);
  }

  /** Hovers the card and returns the tooltip that opens beside it. */
  async hoverTooltip(worktreeId: string): Promise<Locator> {
    await this.card(worktreeId).hover();
    const tooltip = this.page.getByTestId("worktree-card__tooltip");
    await expect(tooltip).toBeVisible();
    return tooltip;
  }
}
