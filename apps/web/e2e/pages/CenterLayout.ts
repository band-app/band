import { expect, type Locator, type Page, test } from "@playwright/test";

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
   * `release: false` and release with `releaseDrag`. Pass `expectDrop: false` when the layout
   * must not accept a drag (the phone layout), so the call does not wait for an indicator.
   */
  async dragTab(
    panelId: string,
    toGroup: number,
    at: DropAt,
    options: { release?: boolean; expectDrop?: boolean } = {},
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
      // The layout reads its drop target from the last drag-move event, and dnd-kit delivers
      // that event in an effect after the render. A mouse-up sent right after the final move
      // can run first and drop on the previous target (the tab stayed last in CI). Wait until
      // the indicator shows the spot the pointer is over, then release.
      if (options.expectDrop !== false) await this.waitForDropTarget(toGroup, at, { x, y });
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
    // A push that started before the action also matches the responses above,
    // so wait for the store to say that nothing is left to send. The id of
    // every entry changed since its last confirmed write sits in `pending`.
    await expect
      .poll(() =>
        this.page.evaluate(() => {
          const raw = localStorage.getItem("band:client-state:v1");
          if (!raw) throw new Error("band:client-state:v1 is missing from localStorage");
          return (JSON.parse(raw).pending as string[]).length;
        }),
      )
      .toBe(0);
  }

  /** Wait until the drop indicator shows where a pointer at `at` of group `toGroup` would drop. */
  private async waitForDropTarget(
    toGroup: number,
    at: DropAt,
    pointer: { x: number; y: number },
  ): Promise<void> {
    if (at === "tabs-start" || at === "tabs-end") {
      const tabs = this.groups.nth(toGroup).locator("[data-panel-id]");
      let nudge = 0;
      await expect
        .poll(async () => {
          // The indicator is placed from the tab rects at the last pointer move. Tabs are as wide
          // as their titles, so anything that resizes a tab after that move shifts the strip
          // under a pointer that no longer moves, and the indicator stays at the old spot for good.
          // A person's hand moves a pixel; do the same so the layout hit-tests the strip as it is
          // now.
          nudge = 1 - nudge;
          await this.page.mouse.move(pointer.x + nudge, pointer.y);
          if ((await this.dropIndicator.getAttribute("data-zone")) !== "tabs") return false;
          const line = await this.dropIndicator.boundingBox();
          const edge =
            at === "tabs-start"
              ? await tabs.first().boundingBox()
              : await tabs.last().boundingBox();
          if (!line || !edge) return false;
          const edgeX = at === "tabs-start" ? edge.x : edge.x + edge.width;
          return Math.abs(line.x + line.width / 2 - edgeX) <= 2;
        })
        .toBe(true);
    } else {
      await expect(this.dropIndicator).toHaveAttribute("data-zone", at);
    }
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
