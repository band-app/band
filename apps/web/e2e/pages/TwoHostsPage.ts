/**
 * Page object for a repo whose same-named worktree lives on two hosts. A worktree id carries its
 * host (`<repo>-<branch>@<hostId>`), so the sidebar holds two cards of one name and the page has
 * to keep them apart. It owns the selection and URL reads and composes the other page objects
 * for the sidebar groupings, the file viewer, the Changes panel and the desktop viewer.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { DesktopViewerPage } from "./DesktopViewerPage";
import { type GroupByMode, SidebarGroupingPage } from "./SidebarGroupingPage";
import { WorktreePage } from "./WorktreePage";

export class TwoHostsPage {
  readonly worktree: WorktreePage;
  readonly sidebar: SidebarGroupingPage;
  readonly desktop: DesktopViewerPage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.worktree = new WorktreePage(page, baseUrl, token);
    this.sidebar = new SidebarGroupingPage(page);
    this.desktop = new DesktopViewerPage(page);
  }

  /** Opens the worktree by URL (a full page load) and waits until it is the shown one. */
  async open(worktreeId: string): Promise<void> {
    await this.worktree.goto(worktreeId);
    await this.worktree.waitForReady();
    await this.worktree.waitForWorktreeReady(worktreeId);
  }

  async reload(): Promise<void> {
    await test.step("Reload the page", async () => {
      await this.page.reload();
      await this.worktree.waitForReady();
    });
  }

  async goBack(): Promise<void> {
    await test.step("Go back in the browser history", async () => {
      await this.page.goBack();
    });
  }

  async groupBy(mode: GroupByMode): Promise<void> {
    await this.sidebar.selectMode(mode);
  }

  /** The sidebar card of a worktree, in whichever grouping is on. */
  card(worktreeId: string): Locator {
    return this.worktree.worktreeCard(worktreeId);
  }

  /** Clicks a card, which switches worktree through the app's own navigation. */
  async select(worktreeId: string): Promise<void> {
    await test.step(`Select ${worktreeId} in the sidebar`, async () => {
      await this.card(worktreeId).click();
    });
  }

  /** The decoded path of the current URL, e.g. `/worktree/proj-feat-same@h-abc`. */
  currentPath(): string {
    return decodeURIComponent(new URL(this.page.url()).pathname);
  }

  /** The ids of every card the sidebar marks as the current page, in document order. */
  async selectedCardIds(): Promise<string[]> {
    return this.page
      .locator('[data-testid^="repo-list__worktree-card--"][aria-current="page"]')
      .evaluateAll((els) =>
        els.map((el) =>
          (el.getAttribute("data-testid") ?? "").replace("repo-list__worktree-card--", ""),
        ),
      );
  }

  /** Waits until `worktreeId` is the only selected card and the URL names it. */
  async expectOnlySelected(worktreeId: string): Promise<void> {
    await test.step(`Only ${worktreeId} is selected`, async () => {
      await expect.poll(() => this.selectedCardIds()).toEqual([worktreeId]);
      await expect(this.card(worktreeId)).toHaveAttribute("aria-current", "page");
      expect(this.currentPath()).toBe(`/worktree/${worktreeId}`);
    });
  }

  /** The chat tab of one worktree's tab strip (hidden worktrees stay mounted, so it is scoped). */
  chatTab(worktreeId: string, chatId: string): Locator {
    return this.worktree.cachedPanelEntries(worktreeId).getByTestId(`center-chat-tab--${chatId}`);
  }
}
