/**
 * Page object for moving a worktree whose host is online: the "Open on another host…" item in a
 * worktree card's menu and the dialog it opens. Locators use the test ids set in
 * `WorktreeCard.tsx` and `MoveWorktreeDialog.tsx`.
 */

import { type Locator, type Page, test } from "@playwright/test";

export class MoveWorktreePage {
  constructor(private readonly page: Page) {}

  card(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  get menuItem(): Locator {
    return this.page.getByTestId("worktree-card__move");
  }

  get dialog(): Locator {
    return this.page.getByTestId("move-worktree__dialog");
  }

  get ignoredFilesNote(): Locator {
    return this.dialog.getByTestId("move-worktree__ignored-files");
  }

  get result(): Locator {
    return this.page.getByTestId("move-worktree__result");
  }

  async openFromCard(worktreeId: string): Promise<void> {
    await test.step(`Open the move dialog of ${worktreeId}`, async () => {
      await this.card(worktreeId).click({ button: "right" });
      await this.menuItem.click();
    });
  }

  async submit(): Promise<void> {
    await test.step("Move the worktree", async () => {
      await this.dialog.getByTestId("move-worktree__submit").click();
    });
  }
}
