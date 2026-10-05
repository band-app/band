/**
 * Page object for the PR badge in a sidebar worktree row
 * (`dashboard/components/PullRequestBadge.tsx`): the PR number as an
 * outlined tag, `worktree-card__pr-badge` (its `data-tone` is the CI color:
 * `failure`, `pending`, `success`, `neutral`, `merged` or `closed`), and its
 * popover `pr-popover`, with `pr-popover__number` (the same tag, with the
 * same `data-tone`), `__status`, `__draft`, `__title`, `__open` and
 * `__copy`. The status element's `data-status` is the CI state
 * (or `merged` / `closed`), and the copy button has `data-copied` while it
 * shows its confirmation. A row without a PR shows the CI icon
 * `worktree-card__ci-icon` instead. `badgeOutline` and `popoverOutline`
 * read a tag's computed border, and `rowHeight` a sidebar row's height.
 *
 * Navigation, the worktree card and clipboard capture are delegated to
 * `WorktreePage`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { WorktreePage } from "./WorktreePage";

/** A tag's border width, style and color, and corner radius. */
export interface TagOutline {
  width: string;
  style: string;
  color: string;
  radius: string;
}

function readOutline(tag: Locator): Promise<TagOutline> {
  return tag.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      width: s.borderTopWidth,
      style: s.borderTopStyle,
      color: s.borderTopColor,
      radius: s.borderTopLeftRadius,
    };
  });
}

export class PullRequestBadgePage {
  readonly popover: Locator;
  readonly popoverNumber: Locator;
  readonly popoverStatus: Locator;
  readonly popoverDraft: Locator;
  readonly popoverTitle: Locator;
  readonly openButton: Locator;
  readonly copyButton: Locator;

  readonly worktree: WorktreePage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.worktree = new WorktreePage(page, baseUrl, token);
    this.popover = page.getByTestId("pr-popover");
    this.popoverNumber = page.getByTestId("pr-popover__number");
    this.popoverStatus = page.getByTestId("pr-popover__status");
    this.popoverDraft = page.getByTestId("pr-popover__draft");
    this.popoverTitle = page.getByTestId("pr-popover__title");
    this.openButton = page.getByTestId("pr-popover__open");
    this.copyButton = page.getByTestId("pr-popover__copy");
  }

  /** Open a worktree and wait until the sidebar and plugin tabs are in. */
  async goto(worktreeId: string): Promise<void> {
    await this.worktree.gotoAndWaitForPlugins(worktreeId);
    await this.worktree.waitForReady();
  }

  /** The PR badge in `worktreeId`'s sidebar row. */
  badge(worktreeId: string): Locator {
    return this.worktree.worktreeCard(worktreeId).getByTestId("worktree-card__pr-badge");
  }

  /** The CI icon in `worktreeId`'s row, shown when its branch has no PR. */
  ciIcon(worktreeId: string): Locator {
    return this.worktree.worktreeCard(worktreeId).getByTestId("worktree-card__ci-icon");
  }

  /**
   * Answer github.com page loads with an empty page. "Open on GitHub" opens a
   * top-level popup on github.com, a site the server never calls, so there
   * is no env-var stub for it; routing the browser is the only hermetic way
   * to let the popup load.
   */
  async stubGitHubPages(): Promise<void> {
    await this.page
      .context()
      .route("https://github.com/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<title>GitHub</title>" }),
      );
  }

  /** The badge's rendered text color, as the browser computed it. */
  async badgeColor(worktreeId: string): Promise<string> {
    return this.badge(worktreeId).evaluate((el) => getComputedStyle(el).color);
  }

  /** The badge's tag outline as the browser computed it. */
  async badgeOutline(worktreeId: string): Promise<TagOutline> {
    return readOutline(this.badge(worktreeId));
  }

  /** The popover number's tag outline as the browser computed it. */
  async popoverOutline(): Promise<TagOutline> {
    return readOutline(this.popoverNumber);
  }

  /** The rendered height of `worktreeId`'s sidebar row, in CSS pixels. */
  async rowHeight(worktreeId: string): Promise<number> {
    const box = await this.worktree.worktreeCard(worktreeId).boundingBox();
    if (!box) throw new Error(`worktree row ${worktreeId} is not rendered`);
    return box.height;
  }

  async hoverBadge(worktreeId: string): Promise<void> {
    await test.step(`Hover the PR badge of ${worktreeId}`, async () => {
      await this.badge(worktreeId).hover();
      await expect(this.popover).toBeVisible();
    });
  }

  async moveMouseAway(): Promise<void> {
    await test.step("Move the mouse off the badge and popover", async () => {
      await this.page.mouse.move(1, 1);
    });
  }

  /**
   * Reach the badge from the keyboard: focus the worktree row, then Tab to
   * the badge, the row's next focusable element.
   */
  async focusBadgeWithKeyboard(worktreeId: string): Promise<void> {
    await test.step(`Tab to the PR badge of ${worktreeId}`, async () => {
      await expect(this.badge(worktreeId)).toBeVisible();
      await this.worktree.worktreeCard(worktreeId).focus();
      await this.page.keyboard.press("Tab");
      await expect(this.badge(worktreeId)).toBeFocused();
    });
  }

  async pressKey(key: string): Promise<void> {
    await test.step(`Press ${key}`, async () => {
      await this.page.keyboard.press(key);
    });
  }

  async clickBadge(worktreeId: string): Promise<void> {
    await test.step(`Click the PR badge of ${worktreeId}`, async () => {
      await this.badge(worktreeId).click();
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
