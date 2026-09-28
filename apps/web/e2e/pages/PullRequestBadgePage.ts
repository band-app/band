/**
 * Page object for the PR badge in a sidebar workspace row
 * (`dashboard/components/PullRequestBadge.tsx`): the PR number as an
 * outlined tag, `workspace-card__pr-badge` (its `data-tone` is the CI color:
 * `failure`, `pending`, `success`, `neutral`, `merged` or `closed`), and its
 * popover `pr-popover`, with `pr-popover__number` (the same tag, with the
 * same `data-tone`), `__status`, `__draft`, `__title`, `__open` and
 * `__copy`. The status element's `data-status` is the CI state
 * (or `merged` / `closed`), and the copy button has `data-copied` while it
 * shows its confirmation. A row without a PR shows the CI icon
 * `workspace-card__ci-icon` instead. `badgeOutline` and `popoverOutline`
 * read a tag's computed border, and `rowHeight` a sidebar row's height.
 *
 * Navigation, the workspace card and clipboard capture are delegated to
 * `WorkspacePage`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { WorkspacePage } from "./WorkspacePage";

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

  /** The CI icon in `workspaceId`'s row, shown when its branch has no PR. */
  ciIcon(workspaceId: string): Locator {
    return this.workspace.workspaceCard(workspaceId).getByTestId("workspace-card__ci-icon");
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
  async badgeColor(workspaceId: string): Promise<string> {
    return this.badge(workspaceId).evaluate((el) => getComputedStyle(el).color);
  }

  /** The badge's tag outline as the browser computed it. */
  async badgeOutline(workspaceId: string): Promise<TagOutline> {
    return readOutline(this.badge(workspaceId));
  }

  /** The popover number's tag outline as the browser computed it. */
  async popoverOutline(): Promise<TagOutline> {
    return readOutline(this.popoverNumber);
  }

  /** The rendered height of `workspaceId`'s sidebar row, in CSS pixels. */
  async rowHeight(workspaceId: string): Promise<number> {
    const box = await this.workspace.workspaceCard(workspaceId).boundingBox();
    if (!box) throw new Error(`workspace row ${workspaceId} is not rendered`);
    return box.height;
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
