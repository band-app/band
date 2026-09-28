/**
 * Page object for the PR badge in a sidebar workspace row
 * (`dashboard/components/PullRequestBadge.tsx`): the PR number
 * `workspace-card__pr-badge` (its `data-tone` is the CI color: `failure`,
 * `pending`, `success`, `neutral`, `merged` or `closed`) and its popover
 * `pr-popover`, with `pr-popover__number`, `__status`, `__draft`, `__title`,
 * `__open` and `__copy`.
 *
 * Navigation, the workspace card and clipboard capture are delegated to
 * `WorkspacePage`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { WorkspacePage } from "./WorkspacePage";

export class PullRequestBadgePage {
  readonly popover: Locator;
  readonly popoverNumber: Locator;
  readonly popoverStatus: Locator;
  readonly popoverDraft: Locator;
  readonly popoverTitle: Locator;
  readonly openButton: Locator;
  readonly copyButton: Locator;

  readonly workspace: WorkspacePage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.workspace = new WorkspacePage(page, baseUrl, token);
    this.popover = page.getByTestId("pr-popover");
    this.popoverNumber = page.getByTestId("pr-popover__number");
    this.popoverStatus = page.getByTestId("pr-popover__status");
    this.popoverDraft = page.getByTestId("pr-popover__draft");
    this.popoverTitle = page.getByTestId("pr-popover__title");
    this.openButton = page.getByTestId("pr-popover__open");
    this.copyButton = page.getByTestId("pr-popover__copy");
  }

  /** Open a workspace and wait until the sidebar and plugin tabs are in. */
  async goto(workspaceId: string): Promise<void> {
    await this.workspace.gotoAndWaitForPlugins(workspaceId);
    await this.workspace.waitForReady();
  }

  /** The PR badge in `workspaceId`'s sidebar row. */
  badge(workspaceId: string): Locator {
    return this.workspace.workspaceCard(workspaceId).getByTestId("workspace-card__pr-badge");
  }

  /** The badge's rendered text color, as the browser computed it. */
  async badgeColor(workspaceId: string): Promise<string> {
    return this.badge(workspaceId).evaluate((el) => getComputedStyle(el).color);
  }

  async hoverBadge(workspaceId: string): Promise<void> {
    await test.step(`Hover the PR badge of ${workspaceId}`, async () => {
      await this.badge(workspaceId).hover();
      await expect(this.popover).toBeVisible();
    });
  }

  async moveMouseAway(): Promise<void> {
    await test.step("Move the mouse off the badge and popover", async () => {
      await this.page.mouse.move(1, 1);
    });
  }

  /**
   * Reach the badge from the keyboard: focus the workspace row, then Tab to
   * the badge, the row's next focusable element.
   */
  async focusBadgeWithKeyboard(workspaceId: string): Promise<void> {
    await test.step(`Tab to the PR badge of ${workspaceId}`, async () => {
      await expect(this.badge(workspaceId)).toBeVisible();
      await this.workspace.workspaceCard(workspaceId).focus();
      await this.page.keyboard.press("Tab");
      await expect(this.badge(workspaceId)).toBeFocused();
    });
  }

  async pressKey(key: string): Promise<void> {
    await test.step(`Press ${key}`, async () => {
      await this.page.keyboard.press(key);
    });
  }

  async clickBadge(workspaceId: string): Promise<void> {
    await test.step(`Click the PR badge of ${workspaceId}`, async () => {
      await this.badge(workspaceId).click();
    });
  }

  /** Click "Open on GitHub" and return the page it opened. */
  async openOnGitHub(): Promise<Page> {
    return await test.step("Open the pull request on GitHub", async () => {
      const popup = this.page.waitForEvent("popup");
      await this.openButton.click();
      return await popup;
    });
  }

  async copyLink(): Promise<void> {
    await test.step("Copy the pull request's link", async () => {
      await this.copyButton.click();
    });
  }
}
