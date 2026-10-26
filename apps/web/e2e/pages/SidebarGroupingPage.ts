/**
 * Page object for the sidebar's worktree rows, their nesting under a parent and the Set parent /
 * Remove parent items of a worktree card's context menu.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class SidebarGroupingPage {
  readonly startedFrom: Locator;

  constructor(private readonly page: Page) {
    this.startedFrom = page.getByTestId("started-from").filter({ visible: true });
  }

  /** Asserts that no header control overlaps the title or sticks out of the header. */
  async expectHeaderFits(): Promise<void> {
    await test.step("The Repos header controls fit beside the title", async () => {
      const header = this.page.getByTestId("repos-panel__header").filter({ visible: true });
      const headerBox = await header.boundingBox();
      const titleBox = await header.locator("span").first().boundingBox();
      expect(headerBox).not.toBeNull();
      expect(titleBox).not.toBeNull();
      const buttons = header.getByRole("button");
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const box = await buttons.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
        expect(box!.x + box!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 0.5);
      }
    });
  }

  /** A worktree row of the group list. */
  row(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__grouped-row--${worktreeId}`);
  }

  originToggle(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__origin-toggle--${worktreeId}`);
  }

  parentRemovedHint(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__parent-removed--${worktreeId}`);
  }

  /** The gray host tag inside a worktree row or repo-mode card. */
  hostTag(rowOrCard: Locator): Locator {
    return rowOrCard.getByTestId("worktree-label__host");
  }

  /** The repo avatar (or its folder fallback) on an Origin row. */
  repoAvatar(row: Locator, repo: string): Locator {
    return row.locator(
      `[data-testid="worktree-label__avatar--${repo}"], [data-testid="worktree-label__avatar--${repo}-fallback"]`,
    );
  }

  /** The ids of the worktree rows in display order, with the depth of each. */
  async rowOrder(): Promise<Array<{ id: string; depth: number }>> {
    const rows = this.page.locator('[data-testid^="repo-list__grouped-row--"]');
    return rows.evaluateAll((els) =>
      els.map((el) => ({
        id: (el.getAttribute("data-testid") ?? "").replace("repo-list__grouped-row--", ""),
        depth: Number(el.getAttribute("data-depth")),
      })),
    );
  }

  /** The repo-mode sidebar card of a worktree. */
  repoModeCard(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  /** Right-clicks a worktree's row or card and opens the Set parent dialog. */
  async openSetParent(target: Locator): Promise<void> {
    await test.step("Open Set parent from the context menu", async () => {
      await this.openMenu(target);
      await this.page.getByTestId("worktree-card__set-parent").click();
      await expect(this.setParentDialog).toBeVisible();
    });
  }

  get setParentDialog(): Locator {
    return this.page.getByTestId("set-parent__dialog");
  }

  setParentItem(worktreeId: string): Locator {
    return this.page.getByTestId(`set-parent__item--${worktreeId}`);
  }

  /** Types into the dialog's search box and picks a worktree. */
  async chooseParent(search: string, worktreeId: string): Promise<void> {
    await test.step(`Pick ${worktreeId} as the parent`, async () => {
      await this.setParentDialog.getByRole("combobox").fill(search);
      await this.setParentItem(worktreeId).click();
      await expect(this.setParentDialog).toBeHidden();
    });
  }

  get removeParentItem(): Locator {
    return this.page.getByTestId("worktree-card__remove-parent");
  }

  /** Right-clicks the target and opens the menu without choosing anything. */
  async openMenu(target: Locator): Promise<void> {
    await target.click({ button: "right" });
  }

  /**
   * Picks Remove parent and waits for the menu to leave the DOM. The menu plays an exit animation
   * before it unmounts, and on unmount Radix puts focus back on the row that opened it. A key press
   * sent before that lands on the row again, so a caller that moves on at once can see its Enter
   * open this row instead of the highlighted one.
   */
  async removeParent(target: Locator): Promise<void> {
    await test.step("Remove the parent from the context menu", async () => {
      await this.openMenu(target);
      await this.removeParentItem.click();
      await expect(this.removeParentItem).toHaveCount(0);
    });
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  /** Moves the keyboard highlight one row down and opens it. */
  async openNextRowWithKeyboard(): Promise<void> {
    await this.page.keyboard.press("ArrowDown");
    await this.page.keyboard.press("Enter");
  }
}
