import { type CDPSession, type Locator, type Page, test } from "@playwright/test";

/** Scroll state of the tab list, in CSS px. */
export interface TabStripScroll {
  scrollLeft: number;
  /** `scrollWidth - clientWidth`; above 0 means some tabs are out of view. */
  maxScrollLeft: number;
}

/**
 * The visible center layout's tab strip (`WorktreeCenter`).
 *
 * The strip is Band's own markup (`layout/LayoutView.tsx`) and carries
 * `data-testid` hooks: `layout-tab-list` is the scrolling list of tabs,
 * `layout-header` the row with the actions on either side. The center layout is
 * told apart from a terminal tab's split panes by `data-layout-kind="center"`.
 * Tabs are located by callers from `WorktreePage` (`fileTab`, …) so the testid
 * format lives in one place.
 */
export class CenterTabStrip {
  /** The scrollable list of tabs in the visible worktree's center layout. */
  readonly list: Locator;
  /** A hidden-tabs dropdown: the strip scrolls instead, so there is none. */
  readonly overflowDropdown: Locator;
  /** The strip row: the tabs plus the header actions on either side. */
  readonly strip: Locator;
  /** The "+" button that opens the new-tab menu. */
  readonly newTabButton: Locator;
  /** The phone strip's ⋮ button holding the active tab's actions. */
  readonly tabActionsButton: Locator;

  constructor(private readonly page: Page) {
    const center = page.locator('[data-layout-kind="center"]');
    this.list = center
      .locator(
        ':scope > [data-testid="layout-group"] > [data-testid="layout-header"] > [data-testid="layout-tab-list"]',
      )
      .filter({ visible: true });
    this.strip = center
      .locator(':scope > [data-testid="layout-group"] > [data-testid="layout-header"]')
      .filter({ visible: true });
    this.newTabButton = page
      .getByTestId("worktree-center__new-tab-button")
      .filter({ visible: true });
    this.tabActionsButton = page
      .getByTestId("worktree-center__tab-actions-button")
      .filter({ visible: true });
    this.overflowDropdown = center.getByTestId("layout-tab-overflow").filter({ visible: true });
  }

  async readScroll(): Promise<TabStripScroll> {
    return await this.list.evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      maxScrollLeft: el.scrollWidth - el.clientWidth,
    }));
  }

  /** The height of the area a finger can tap to pick `tab`: the layout's
   *  tab wrapper around the tab Band renders. */
  async readTabTapHeight(tab: Locator): Promise<number> {
    return await tab.evaluate((el) => {
      const wrapper = el.closest('[data-testid="layout-tab"]');
      if (!wrapper) throw new Error("tab is not inside a layout tab wrapper");
      return wrapper.getBoundingClientRect().height;
    });
  }

  /** Whether the list hides its own scroll bar (a phone strip has no use for one). */
  async hasHiddenScrollbar(): Promise<boolean> {
    return await this.list.evaluate((el) => getComputedStyle(el).scrollbarWidth === "none");
  }

  /** How the browser would treat a swipe past the strip's end: `contain` stops
   *  it from becoming back/forward navigation. */
  async overscrollBehaviorX(): Promise<string> {
    return await this.list.evaluate((el) => getComputedStyle(el).overscrollBehaviorX);
  }

  /** Scroll the strip the way a mouse wheel does: a vertical delta only. */
  async mouseWheel(deltaY: number): Promise<void> {
    await test.step(`Wheel the tab strip by ${deltaY}px`, async () => {
      const box = await this.list.boundingBox();
      if (!box) throw new Error("tab strip has no bounding box — not visible");
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await this.page.mouse.wheel(0, deltaY);
    });
  }

  /** Wait until the list stops scrolling: activating a tab scrolls it into
   *  view, and that scroll can still be running when a test acts next. */
  async waitForScrollSettled(): Promise<void> {
    await test.step("Wait for the tab strip to stop scrolling", async () => {
      await this.list.evaluate(
        (el) =>
          new Promise<void>((resolve, reject) => {
            const deadline = performance.now() + 5_000;
            let last = el.scrollLeft;
            let still = 0;
            const tick = () => {
              still = el.scrollLeft === last ? still + 1 : 0;
              last = el.scrollLeft;
              if (still >= 5) resolve();
              else if (performance.now() > deadline) {
                reject(new Error("tab strip still scrolling after 5000 ms"));
              } else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    });
  }

  /** How many `scroll` events the list fires over `ms` milliseconds. */
  async countScrollEventsWhileIdle(ms: number): Promise<number> {
    return await this.list.evaluate(
      (el, duration) =>
        new Promise<number>((resolve) => {
          let count = 0;
          const onScroll = () => count++;
          el.addEventListener("scroll", onScroll);
          setTimeout(() => {
            el.removeEventListener("scroll", onScroll);
            resolve(count);
          }, duration);
        }),
      ms,
    );
  }

  /** Whether `tab` lies entirely inside the strip's visible area. */
  async isTabFullyShown(tab: Locator): Promise<boolean> {
    const [box, list] = await Promise.all([tab.boundingBox(), this.list.boundingBox()]);
    if (!box || !list) return false;
    return box.x >= list.x - 1 && box.x + box.width <= list.x + list.width + 1;
  }

  /** Swipe the strip sideways the way a trackpad does: a wheel event with a
   *  horizontal delta only. */
  async trackpadSwipe(deltaX: number): Promise<void> {
    await test.step(`Trackpad-swipe the tab strip by ${deltaX}px`, async () => {
      const box = await this.list.boundingBox();
      if (!box) throw new Error("tab strip has no bounding box — not visible");
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await this.page.mouse.wheel(deltaX, 0);
    });
  }

  /** Drag a finger along the strip, starting on `startTab`. `distance` is how
   *  far the finger moves left, so a positive value scrolls toward the tabs on
   *  the right. Sends raw touch start / move / end input, which Chromium turns
   *  into touch pointer events plus a native pan, the same as a phone.
   *  (`Input.synthesizeScrollGesture` sends no touchmove events on the Linux
   *  headless shell CI runs, so it can't stand in for a finger there.) */
  async touchSwipe(startTab: Locator, distance: number): Promise<void> {
    await test.step(`Swipe the tab strip ${distance}px with a finger`, async () => {
      const { x, y } = await this.touchPoint(startTab);
      await this.dispatchSwipe(x, y, distance);
    });
  }

  /** Swipe a finger `distance` px across the middle of the strip, as
   *  `touchSwipe` does, with the whole path inside the strip: Chromium drops
   *  touch points outside the viewport, so a long swipe there scrolls
   *  nothing. `distance` must be shorter than the strip is wide. */
  async touchSwipeAcross(distance: number): Promise<void> {
    await test.step(`Swipe across the tab strip ${distance}px with a finger`, async () => {
      const box = await this.list.boundingBox();
      if (!box) throw new Error("tab strip has no bounding box — not visible");
      if (Math.abs(distance) >= box.width) throw new Error("swipe is wider than the strip");
      const x = Math.round(box.x + box.width / 2 + distance / 2);
      await this.dispatchSwipe(x, Math.round(box.y + box.height / 2), distance);
    });
  }

  async tap(target: Locator): Promise<void> {
    await test.step("Tap a tab strip element", async () => {
      await target.tap();
    });
  }

  /** The middle of the part of `tab` the strip shows: a tab at the edge can
   *  extend past the strip, under the header actions. */
  private async touchPoint(tab: Locator): Promise<{ x: number; y: number }> {
    const [box, list] = await Promise.all([tab.boundingBox(), this.list.boundingBox()]);
    if (!box || !list) throw new Error("tab or strip has no bounding box — not visible");
    const left = Math.max(box.x, list.x);
    const right = Math.min(box.x + box.width, list.x + list.width);
    if (right <= left) throw new Error("tab is scrolled out of the strip");
    return { x: Math.round((left + right) / 2), y: Math.round(box.y + box.height / 2) };
  }

  private async dispatchSwipe(x: number, y: number, distance: number): Promise<void> {
    const steps = 10;
    await this.withCdp(async (cdp) => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x - (distance * i) / steps, y }],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
  }

  private async withCdp(fn: (cdp: CDPSession) => Promise<unknown>): Promise<void> {
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      await fn(cdp);
    } finally {
      await cdp.detach();
    }
  }
}
