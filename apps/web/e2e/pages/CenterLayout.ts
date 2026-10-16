import { type Locator, type Page, test } from "@playwright/test";

/** Where a dragged tab is dropped on a group. */
export type DropAt = "tabs-start" | "tabs-end" | "left" | "right" | "top" | "bottom" | "center";

/**
 * The visible worktree's center layout: its groups, their tabs, the sashes
 * between them, and dragging a tab (`layout/LayoutView.tsx`). Groups are the
 * direct children of the center layout root, so the split panes inside a
 * terminal tab do not count.
 */
export class CenterLayout {
  readonly groups: Locator;
  readonly sashes: Locator;
  readonly dropIndicator: Locator;
  private readonly root: Locator;

  constructor(private readonly page: Page) {
    const root = page.locator('[data-layout-kind="center"]').filter({ visible: true });
    this.root = root;
    this.groups = root.locator(':scope > [data-testid="layout-group"]');
    this.sashes = root.locator(':scope > [data-testid="layout-sash"]');
    this.dropIndicator = root.getByTestId("layout-drop-indicator");
  }

  /** Panel ids of the tabs in group `index`, left to right. */
  async tabIds(index: number): Promise<string[]> {
    return await this.groups
      .nth(index)
      .locator(':scope > [data-testid="layout-header"] [data-testid="layout-tab"]')
      .evaluateAll((tabs) => tabs.map((t) => t.getAttribute("data-panel-id") ?? ""));
  }

  /** The tab wrapper with this panel id. */
  tab(panelId: string): Locator {
    return this.page
      .locator('[data-layout-kind="center"] [data-testid="layout-tab"]')
      .and(this.page.locator(`[data-panel-id="${panelId}"]`));
  }

  /** Width of the center layout area. */
  async rootWidth(): Promise<number> {
    return (await this.root.first().boundingBox())?.width ?? 0;
  }

  async groupWidth(index: number): Promise<number> {
    return (await this.groups.nth(index).boundingBox())?.width ?? 0;
  }

  /**
   * Drag the tab `panelId` to a spot on group `toGroup` with the mouse, in
   * steps so the drag starts (it needs a few pixels of movement) and the drop
   * indicator follows. The mouse is released over the spot; call
   * `dropIndicator` before this returns control to read it, or pass
   * `release: false` and release with `releaseDrag`.
   */
  async dragTab(
    panelId: string,
    toGroup: number,
    at: DropAt,
    options: { release?: boolean } = {},
  ): Promise<void> {
    await test.step(`Drag tab ${panelId} to ${at} of group ${toGroup}`, async () => {
      const tab = await this.tab(panelId).boundingBox();
      const group = await this.groups.nth(toGroup).boundingBox();
      const header = await this.groups
        .nth(toGroup)
        .locator(':scope > [data-testid="layout-header"]')
        .boundingBox();
      if (!tab || !group || !header) throw new Error("tab or group is not laid out for a drag");
      const startX = tab.x + tab.width / 2;
      const startY = tab.y + tab.height / 2;
      const content = {
        top: header.y + header.height,
        height: group.y + group.height - header.y - header.height,
      };
      let x: number;
      let y: number;
      switch (at) {
        case "tabs-start":
          x = header.x + 2;
          y = header.y + header.height / 2;
          break;
        case "tabs-end":
          x = group.x + group.width - 4;
          y = header.y + header.height / 2;
          break;
        case "left":
          x = group.x + group.width * 0.1;
          y = content.top + content.height / 2;
          break;
        case "right":
          x = group.x + group.width * 0.9;
          y = content.top + content.height / 2;
          break;
        case "top":
          x = group.x + group.width / 2;
          y = content.top + content.height * 0.1;
          break;
        case "bottom":
          x = group.x + group.width / 2;
          y = content.top + content.height * 0.9;
          break;
        default:
          x = group.x + group.width / 2;
          y = content.top + content.height / 2;
      }
      await this.page.mouse.move(startX, startY);
      await this.page.mouse.down();
      await this.page.mouse.move(startX + 12, startY + 12, { steps: 4 });
      await this.page.mouse.move(x, y, { steps: 12 });
      if (options.release !== false) await this.page.mouse.up();
    });
  }

  /**
   * Run `action` and wait until the layout and the shared tab list it changed
   * reached the server. The UI pushes both a moment after a change, and a
   * change made before that push lands can be overwritten by the server's
   * older copy, as it would be for a second device.
   */
  async whileSynced(action: () => Promise<void>): Promise<void> {
    const pushed = (key: string) =>
      this.page.waitForResponse(
        (r) => r.url().includes("clientState.set") && (r.request().postData() ?? "").includes(key),
      );
    const synced = Promise.all([pushed("dockview-layout-v9"), pushed("center-tabs")]);
    await action();
    await synced;
  }

  async releaseDrag(): Promise<void> {
    await this.page.mouse.up();
  }

  /** Drag the sash `index` by `dx` px (a vertical sash) or `dy` px (a horizontal one). */
  async dragSash(index: number, delta: { dx?: number; dy?: number }): Promise<void> {
    await test.step(`Drag sash ${index}`, async () => {
      const box = await this.sashes.nth(index).boundingBox();
      if (!box) throw new Error("sash is not laid out");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.page.mouse.move(x, y);
      await this.page.mouse.down();
      await this.page.mouse.move(x + (delta.dx ?? 0), y + (delta.dy ?? 0), { steps: 10 });
      await this.page.mouse.up();
    });
  }
}
