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

  constructor(private readonly page: Page) {
    this.dialog = page.getByTestId("desktop-viewer__dialog");
    this.screen = page.getByTestId("desktop-viewer__screen");
    this.canvas = this.screen.locator("canvas");
    this.mode = page.getByTestId("desktop-viewer__mode");
    this.resolution = page.getByTestId("desktop-viewer__resolution");
    this.hostName = page.getByTestId("desktop-viewer__host");
    this.controlToggle = page.getByTestId("desktop-viewer__control-toggle");
    this.error = page.getByTestId("desktop-viewer__error");
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

  async pressKey(key: string): Promise<void> {
    await this.canvas.focus();
    await this.page.keyboard.press(key);
  }
}
