/**
 * Page object for the desktop viewer dialog (`DesktopViewerDialog.tsx`): noVNC's canvas, the
 * status bar and the Take control toggle. Test bodies call these methods, never `page.getByTestId`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class DesktopViewerPage {
  readonly dialog: Locator;
  readonly screen: Locator;
  readonly canvas: Locator;
  readonly mode: Locator;
  readonly resolution: Locator;
  readonly hostName: Locator;
  readonly controlToggle: Locator;
  readonly error: Locator;
  readonly root: Locator;
  readonly fitButton: Locator;
  readonly actualSizeButton: Locator;
  readonly fullscreenButton: Locator;
  readonly closeButton: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByTestId("desktop-viewer__dialog");
    this.screen = page.getByTestId("desktop-viewer__screen");
    this.canvas = this.screen.locator("canvas");
    this.mode = page.getByTestId("desktop-viewer__mode");
    this.resolution = page.getByTestId("desktop-viewer__resolution");
    this.hostName = page.getByTestId("desktop-viewer__host");
    this.controlToggle = page.getByTestId("desktop-viewer__control-toggle");
    this.error = page.getByTestId("desktop-viewer__error");
    this.root = page.getByTestId("desktop-viewer");
    this.fitButton = this.dialog.getByRole("radio", { name: "Fit" });
    this.actualSizeButton = this.dialog.getByRole("radio", { name: "Actual size" });
    this.fullscreenButton = page.getByTestId("desktop-viewer__fullscreen");
    this.closeButton = page.getByTestId("desktop-viewer__close");
  }

  /** The worktree header's desktop button. */
  get headerButton(): Locator {
    return this.page.getByTestId("worktree-center__open-desktop");
  }

  /** The Hosts settings row's button for one host. */
  hostRowButton(hostId: string): Locator {
    return this.page
      .getByTestId("settings__host")
      .filter({
        has: this.page.getByTestId("settings__host-id").getByText(hostId, { exact: true }),
      })
      .getByTestId("settings__host-open-desktop");
  }

  /** Waits until the canvas holds drawn pixels, which only a framebuffer update can put there. */
  async expectFramebuffer(): Promise<void> {
    await test.step("The canvas shows a framebuffer", async () => {
      await expect(this.canvas).toBeVisible();
      await expect
        .poll(
          () =>
            this.canvas.evaluate((el) => {
              const canvas = el as HTMLCanvasElement;
              const ctx = canvas.getContext("2d");
              if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
              const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let lit = 0;
              for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] > 0 && (data[i] | data[i + 1] | data[i + 2]) > 0) lit++;
              }
              return lit;
            }),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
    });
  }

  async takeControl(): Promise<void> {
    await test.step("Take control", async () => {
      await this.controlToggle.click();
      await expect(this.mode).toHaveAttribute("data-mode", "control");
    });
  }

  async releaseControl(): Promise<void> {
    await test.step("Release control", async () => {
      await this.controlToggle.click();
      await expect(this.mode).toHaveAttribute("data-mode", "view");
    });
  }

  async fit(): Promise<void> {
    await this.fitButton.click();
    await expect(this.root).toHaveAttribute("data-scale", "fit");
  }

  async actualSize(): Promise<void> {
    await this.actualSizeButton.click();
    await expect(this.root).toHaveAttribute("data-scale", "actual");
  }

  async enterFullscreen(): Promise<void> {
    await test.step("Enter fullscreen", async () => {
      await this.fullscreenButton.click();
      await expect(this.root).toHaveAttribute("data-fullscreen", "true");
    });
  }

  async close(): Promise<void> {
    await test.step("Close the viewer", async () => {
      await this.closeButton.click();
      await expect(this.dialog).toBeHidden();
    });
  }

  async pressEscape(): Promise<void> {
    await this.page.keyboard.press("Escape");
  }

  /** Whether the document's fullscreen element is the viewer. */
  isViewerFullscreen(): Promise<boolean> {
    return this.root.evaluate((el) => document.fullscreenElement === el);
  }

  /** Whether any element is in fullscreen. Works after the viewer has unmounted. */
  isAnythingFullscreen(): Promise<boolean> {
    return this.page.evaluate(() => document.fullscreenElement !== null);
  }

  /** Whether the canvas holds keyboard focus. */
  canvasHasFocus(): Promise<boolean> {
    return this.canvas.evaluate((el) => document.activeElement === el);
  }

  /** The canvas as drawn on the page, in CSS pixels. */
  async canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error("the desktop canvas is not on screen");
    return box;
  }

  /** The area the desktop is drawn in, in CSS pixels. */
  async screenBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await this.screen.boundingBox();
    if (!box) throw new Error("the desktop area is not on screen");
    return box;
  }

  /**
   * Waits until fit mode has scaled the desktop to touch the area on one axis, so the open
   * animation no longer shrinks what a test measures.
   */
  async expectFitSettled(): Promise<void> {
    await expect
      .poll(async () => {
        const area = await this.screenBox();
        const canvas = await this.canvasBox();
        return Math.min(Math.abs(canvas.width - area.width), Math.abs(canvas.height - area.height));
      })
      .toBeLessThanOrEqual(1);
  }

  async dialogBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await this.dialog.boundingBox();
    if (!box) throw new Error("the desktop dialog is not on screen");
    return box;
  }

  /** Scrolls the 1:1 view as far right and down as it goes and returns where it ended up. */
  scrollToEnd(): Promise<{ left: number; top: number }> {
    return this.screen.evaluate((el) => {
      // noVNC draws into its own scrolling element inside the area.
      const scroller = (el.firstElementChild as HTMLElement | null) ?? (el as HTMLElement);
      scroller.scrollLeft = scroller.scrollWidth;
      scroller.scrollTop = scroller.scrollHeight;
      return { left: scroller.scrollLeft, top: scroller.scrollTop };
    });
  }

  /** Clicks the middle of the drawn desktop. */
  async clickDesktop(): Promise<void> {
    await this.canvas.click();
  }

  async pressKey(key: string): Promise<void> {
    await this.canvas.focus();
    await this.page.keyboard.press(key);
  }
}
