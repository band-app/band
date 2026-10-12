import { type CDPSession, type Locator, type Page, test } from "@playwright/test";

/** Scroll state of the tab list, in CSS px. */
export interface TabStripScroll {
  scrollLeft: number;
  /** `scrollWidth - clientWidth`; above 0 means some tabs are out of view. */
  maxScrollLeft: number;
}

/**
 * The visible center dockview's tab strip (`WorktreeCenterDockview`).
 *
 * The strip itself is dockview's markup (`.dv-tabs-container`, its
 * `.dv-scrollable > .dv-scrollbar` custom scrollbar, and the
 * `.dv-tabs-overflow-dropdown-root` "N hidden tabs" control dockview renders
 * when it is enabled; these class names checked against dockview-core 6.0.6),
 * not an element Band owns, so it is located by dockview's own class names,
 * like xterm's textarea elsewhere. Tabs are Band's: callers pass tab locators
 * from `WorktreePage` (`fileTab`, …) so the testid format lives in one place.
 */
export class CenterTabStrip {
  /** The scrollable list of tabs in the visible worktree's dockview. */
  readonly list: Locator;
  /** dockview's hidden-tabs dropdown in the visible worktree's dockview. */
  readonly overflowDropdown: Locator;
  /** dockview's custom 4px scrollbar over the list, in the visible strip. */
  readonly scrollbar: Locator;
  /** The strip row: the tabs plus the header actions on either side. */
  readonly strip: Locator;
  /** The "+" button that opens the new-tab menu. */
  readonly newTabButton: Locator;
  /** The phone strip's ⋮ button holding the active tab's actions. */
  readonly tabActionsButton: Locator;

  constructor(private readonly page: Page) {
    this.list = page.locator(".dockview-center-tabs .dv-tabs-container").filter({ visible: true });
    this.strip = page
      .locator(".dockview-center-tabs .dv-tabs-and-actions-container")
      .filter({ visible: true });
    this.scrollbar = this.strip.locator(".dv-scrollable > .dv-scrollbar");
    this.newTabButton = page
      .getByTestId("worktree-center__new-tab-button")
      .filter({ visible: true });
    this.tabActionsButton = page
      .getByTestId("worktree-center__tab-actions-button")
      .filter({ visible: true });
    this.overflowDropdown = page
      .locator(".dockview-center-tabs .dv-tabs-overflow-dropdown-root")
      .filter({ visible: true });
  }

  async readScroll(): Promise<TabStripScroll> {
    return await this.list.evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      maxScrollLeft: el.scrollWidth - el.clientWidth,
    }));
  }

  /** The height of the area a finger can tap to pick `tab`: dockview's
   *  `.dv-tab` wrapper around the tab Band renders. */
  async readTabTapHeight(tab: Locator): Promise<number> {
    return await tab.evaluate((el) => {
      const wrapper = el.closest(".dv-tab");
      if (!wrapper) throw new Error("tab is not inside a dockview .dv-tab");
      return wrapper.getBoundingClientRect().height;
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
