/**
 * Page object for the sidebar's Group by dropdown (Repo | Origin | Host) and the "Started from"
 * link above a worktree that another worktree started.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export type GroupByMode = "repo" | "origin" | "host";

export class SidebarGroupingPage {
  readonly startedFrom: Locator;
  readonly startedFromLink: Locator;

  constructor(private readonly page: Page) {
    this.startedFrom = page.getByTestId("started-from").filter({ visible: true });
    this.startedFromLink = page.getByTestId("started-from__link").filter({ visible: true });
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
      await expect(this.groupByTrigger).toHaveAccessibleName(new RegExp(`Group by: ${mode}`, "i"));
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

  metaBadge(repo: string): Locator {
    return this.page.getByTestId(`repo-list__meta-badge--${repo}`).first();
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

  /** Waits until the worktree's open tabs are saved (the link reads them to pick the chat). */
  async waitForSavedTabs(worktreeId: string, tabId: string): Promise<void> {
    await expect
      .poll(() =>
        this.page.evaluate(
          ([key]) => window.localStorage.getItem(key) ?? "",
          [`band:center-tabs:${worktreeId}`],
        ),
      )
      .toContain(tabId);
  }

  centerChatTab(chatId: string): Locator {
    return this.page.getByTestId(`center-chat-tab--${chatId}`);
  }

  /** The composer of the chat pane that is on screen (a hidden dockview panel is not visible). */
  get visibleChatComposer(): Locator {
    return this.page.getByTestId("chat-pane__composer").filter({ visible: true });
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
