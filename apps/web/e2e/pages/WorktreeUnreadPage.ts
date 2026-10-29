/**
 * Page object for the unread mark on a worktree card: the dot, the dot's toggle button and the
 * "Mark as read" / "Mark as unread" context-menu item. Locators use the test ids set in
 * `WorktreeCard.tsx` and `AgentStatusIndicator.tsx`.
 */

import { expect, type Locator, type Page } from "@playwright/test";

export class WorktreeUnreadPage {
  constructor(private readonly page: Page) {}

  card(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`).first();
  }

  /** The status slot of a card. `data-status` is `unread`, `idle`, `done` and so on. */
  statusSlot(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__agent-status");
  }

  /** The button inside the status slot. Its accessible name says what a click does. */
  dotButton(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__unread-toggle");
  }

  async openMenu(worktreeId: string): Promise<Locator> {
    await this.card(worktreeId).click({ button: "right" });
    const item = this.page.getByTestId("worktree-card__toggle-unread");
    await expect(item).toBeVisible();
    return item;
  }

  async markViaMenu(worktreeId: string): Promise<void> {
    const item = await this.openMenu(worktreeId);
    await item.click();
  }

  /** Selects a worktree by clicking its card. */
  async select(worktreeId: string): Promise<void> {
    await this.card(worktreeId).click();
    await expect(this.card(worktreeId)).toHaveAttribute("aria-current", "page");
  }
}
