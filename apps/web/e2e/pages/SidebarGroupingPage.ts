/**
 * Page object for the sidebar's Group by dropdown (Repo | Origin | Worker) and the Set parent /
 * Remove parent items of a worktree card's context menu.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export type GroupByMode = "repo" | "origin" | "host";

export class SidebarGroupingPage {
  readonly startedFrom: Locator;

  constructor(private readonly page: Page) {
    this.startedFrom = page.getByTestId("started-from").filter({ visible: true });
  }

  /** The header's Group by dropdown trigger. */
  get groupByTrigger(): Locator {
    return this.page.getByTestId("repos-panel__group-by");
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
      // The current mode stays readable: its label is not squeezed to nothing.
      const modeText = await this.groupByTrigger.locator("span").boundingBox();
      expect(modeText?.width ?? 0).toBeGreaterThan(10);
    });
  }

  modeItem(mode: GroupByMode): Locator {
    return this.page.getByTestId(`repos-panel__group-by--${mode}`);
  }

  async selectMode(mode: GroupByMode): Promise<void> {
    await test.step(`Group the sidebar by ${mode}`, async () => {
      await this.groupByTrigger.click();
      await this.modeItem(mode).click();
      await expect(this.groupByTrigger).toHaveAccessibleName(
        new RegExp(`Group by: ${mode === "host" ? "worker" : mode}`, "i"),
      );
    });
  }

  /** A worktree row of the Origin or Host view. */
  row(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__grouped-row--${worktreeId}`);
  }

  originToggle(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__origin-toggle--${worktreeId}`);
  }

  parentRemovedHint(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__parent-removed--${worktreeId}`);
  }

  hostHeader(hostId: string): Locator {
    return this.page.getByTestId(`repo-list__host-header--${hostId}`);
  }

  hostRepoHeader(hostId: string, repo: string): Locator {
    return this.page.getByTestId(`repo-list__host-repo-header--${hostId}--${repo}`);
  }

  /** The gray host tag inside a worktree row or repo-mode card. */
  hostTag(rowOrCard: Locator): Locator {
    return rowOrCard.getByTestId("worktree-label__host");
  }

  /** The repo avatar (or its folder fallback) on an Origin row. */
  repoAvatar(row: Locator, repo: string): Locator {
    return row.locator(
      `[data-testid="worktree-label__avatar--${repo}"], [data-testid="worktree-label__avatar-fallback--${repo}"]`,
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

  async removeParent(target: Locator): Promise<void> {
    await test.step("Remove the parent from the context menu", async () => {
      await this.openMenu(target);
      await this.removeParentItem.click();
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
