/**
 * Opens the menu surfaces whose highlighted row the list-highlight spec
 * measures: a dropdown menu (a repo's actions in the sidebar) and a context
 * menu (right-click on a worktree card). Each method hovers the first item,
 * which makes it the highlighted one, and returns its contrast against the
 * last item.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { rowContrast } from "./ListHighlight";

export class MenuSurfacesPage {
  constructor(private readonly page: Page) {}

  private get items(): Locator {
    return this.page.getByRole("menuitem");
  }

  private async measure(): Promise<number> {
    const first = this.items.first();
    await first.hover();
    await expect(first).toHaveAttribute("data-highlighted", "");
    return await rowContrast(first, this.items.last());
  }

  async dropdownHighlightContrast(repo: string): Promise<number> {
    return await test.step(`Open the actions dropdown of ${repo}`, async () => {
      await this.page.getByTestId(`repo-list__repo-menu-trigger--${repo}`).first().click();
      await this.items.first().waitFor({ state: "visible" });
      return await this.measure();
    });
  }

  async contextMenuHighlightContrast(worktreeId: string): Promise<number> {
    return await test.step(`Open the context menu of ${worktreeId}`, async () => {
      await this.page
        .getByTestId(`repo-list__worktree-card--${worktreeId}`)
        .first()
        .click({ button: "right" });
      await this.items.first().waitFor({ state: "visible" });
      return await this.measure();
    });
  }

  async screenshot(): Promise<Buffer> {
    return await this.page.screenshot();
  }
}
