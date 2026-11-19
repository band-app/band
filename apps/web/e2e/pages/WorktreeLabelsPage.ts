/**
 * Page object for a worktree's labels: the "Labels…" context-menu item, the dialog that adds and
 * removes them, and the tag icon a labelled card shows.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class WorktreeLabelsPage {
  constructor(private readonly page: Page) {}

  private card(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`).first();
  }

  /** The tag icon a card shows when the worktree has labels. */
  badge(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__labels");
  }

  get dialog(): Locator {
    return this.page.getByTestId("worktree-labels__dialog");
  }

  item(key: string): Locator {
    return this.dialog.getByTestId(`worktree-labels__item--${key}`);
  }

  async open(worktreeId: string): Promise<void> {
    await test.step(`Open the labels dialog of ${worktreeId}`, async () => {
      await this.card(worktreeId).click({ button: "right" });
      await this.page.getByTestId("worktree-card__labels-edit").click();
      await expect(this.dialog).toBeVisible();
    });
  }

  async add(key: string, value: string): Promise<void> {
    await test.step(`Add label ${key}=${value}`, async () => {
      await this.dialog.getByTestId("worktree-labels__key").fill(key);
      await this.dialog.getByTestId("worktree-labels__value").fill(value);
      await this.dialog.getByTestId("worktree-labels__add").click();
      await expect(this.item(key)).toBeVisible();
    });
  }

  /** Submits a pair without waiting for it to appear, for a key the hub refuses. */
  async tryAdd(key: string, value: string): Promise<void> {
    await test.step(`Try to add label ${key}=${value}`, async () => {
      await this.dialog.getByTestId("worktree-labels__key").fill(key);
      await this.dialog.getByTestId("worktree-labels__value").fill(value);
      await this.dialog.getByTestId("worktree-labels__add").click();
    });
  }

  async remove(key: string): Promise<void> {
    await test.step(`Remove label ${key}`, async () => {
      await this.dialog.getByTestId(`worktree-labels__remove--${key}`).click();
      await expect(this.item(key)).toHaveCount(0);
    });
  }

  get error(): Locator {
    return this.dialog.getByTestId("worktree-labels__error");
  }

  async close(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await expect(this.dialog).toHaveCount(0);
  }
}
