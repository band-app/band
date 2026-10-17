/**
 * Page object for the sidebar's Pinned section and for dragging worktrees in the Repo, Origin and
 * Host views. Locators use the test ids set in `RepoList.tsx`, `GroupedWorktrees.tsx` and
 * `SidebarDnd.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

import { SidebarGroupingPage } from "./SidebarGroupingPage";

export type DropPosition = "top" | "middle" | "bottom";

const POSITION_FRACTION: Record<DropPosition, number> = { top: 0.08, middle: 0.5, bottom: 0.92 };

export class SidebarPinsDragPage extends SidebarGroupingPage {
  constructor(private readonly pageRef: Page) {
    super(pageRef);
  }

  get pinnedSection(): Locator {
    return this.pageRef.getByTestId("repo-list__pinned").filter({ visible: true });
  }

  get pinnedHeader(): Locator {
    return this.pageRef.getByTestId("repo-list__pinned-header").filter({ visible: true });
  }

  get collapseAllButton(): Locator {
    return this.pageRef.getByRole("button", { name: "Collapse all" }).filter({ visible: true });
  }

  get dropRefusal(): Locator {
    return this.pageRef.getByTestId("repo-list__drop-refused");
  }

  /** A row of the Pinned section. */
  pinnedRow(worktreeId: string): Locator {
    return this.pageRef.getByTestId(`repo-list__pinned-row--${worktreeId}`);
  }

  /** The card with this id inside the Pinned section. */
  pinnedCard(worktreeId: string): Locator {
    return this.pinnedSection.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  /** Every worktree card on the page with this id: one when nothing is listed twice. */
  card(worktreeId: string): Locator {
    return this.pageRef.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  /** The ids and depths of the Pinned section's rows, in order. */
  async pinnedOrder(): Promise<Array<{ id: string; depth: number }>> {
    return this.pageRef.locator('[data-testid^="repo-list__pinned-row--"]').evaluateAll((els) =>
      els.map((el) => ({
        id: (el.getAttribute("data-testid") ?? "").replace("repo-list__pinned-row--", ""),
        depth: Number(el.getAttribute("data-depth")),
      })),
    );
  }

  /** The ids of the worktree cards outside the Pinned section, in document order. */
  async treeCardOrder(prefix: string): Promise<string[]> {
    return this.pageRef
      .locator(`[data-testid^="repo-list__worktree-card--${prefix}"]`)
      .evaluateAll((els) =>
        els
          .filter((el) => !el.closest('[data-testid="repo-list__pinned"]'))
          .map((el) =>
            (el.getAttribute("data-testid") ?? "").replace("repo-list__worktree-card--", ""),
          ),
      );
  }

  async collapseAll(): Promise<void> {
    await test.step("Click Collapse all", async () => {
      await this.collapseAllButton.click();
    });
  }

  /**
   * dnd-kit swallows the click that follows a drag for 50ms. Waiting a few frames keeps the next
   * click or tap of a test from falling into that window.
   */
  private async settleAfterDrag(): Promise<void> {
    await this.pageRef.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 12;
          const tick = () => (--frames <= 0 ? resolve() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );
  }

  /** Drags `source` with the mouse and drops it at `position` of `target`. */
  async drag(source: Locator, target: Locator, position: DropPosition): Promise<void> {
    await test.step(`Drag a row onto the ${position} of another`, async () => {
      await source.scrollIntoViewIfNeeded();
      const from = await source.boundingBox();
      expect(from).not.toBeNull();
      const startX = from!.x + Math.min(40, from!.width / 2);
      const startY = from!.y + from!.height / 2;
      await this.pageRef.mouse.move(startX, startY);
      await this.pageRef.mouse.down();
      // Past the 8px activation distance first, then on to the target.
      await this.pageRef.mouse.move(startX + 12, startY + 12, { steps: 4 });
      const to = await target.boundingBox();
      expect(to).not.toBeNull();
      const endY = to!.y + to!.height * POSITION_FRACTION[position];
      await this.pageRef.mouse.move(to!.x + Math.min(40, to!.width / 2), endY, { steps: 12 });
      await this.pageRef.mouse.move(to!.x + Math.min(40, to!.width / 2), endY);
      await this.pageRef.mouse.up();
      await this.settleAfterDrag();
    });
  }

  /**
   * Drags with a finger: a 300ms hold, then a move to the `position` of `target`. Chromium's touch
   * events through the DevTools protocol, which is what a phone sends.
   */
  async touchDrag(source: Locator, target: Locator, position: DropPosition): Promise<void> {
    await test.step(`Long-press and drag a row onto the ${position} of another`, async () => {
      // The phone's fly-out slides in: wait until the row is fully on screen before measuring.
      await expect(source).toBeInViewport({ ratio: 1 });
      await expect(target).toBeInViewport({ ratio: 1 });
      const cdp = await this.pageRef.context().newCDPSession(this.pageRef);
      const from = await source.boundingBox();
      const to = await target.boundingBox();
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
      const x = from!.x + Math.min(60, from!.width / 2);
      const startY = from!.y + from!.height / 2;
      const endY = to!.y + to!.height * POSITION_FRACTION[position];
      const touch = (type: string, y: number) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchEnd" ? [] : [{ x, y }],
        });
      await touch("touchStart", startY);
      // The 250 ms touch hold has no DOM signal before the drag starts: wait it out in the page.
      await this.pageRef.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)));
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await touch("touchMove", startY + ((endY - startY) * i) / steps);
      }
      await touch("touchEnd", endY);
      await cdp.detach();
      await this.settleAfterDrag();
    });
  }
}
