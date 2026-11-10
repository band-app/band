/**
 * Page object for the bottom-right toast stack (`ToastHost`), which holds the
 * app update toast, the Home Screen notice and the dashboard's notices. The
 * `data-testid`s are set in `ToastHost.tsx` and `Notification.tsx`.
 */

import { type Locator, type Page, test } from "@playwright/test";

/** A toast's edges and the viewport it sits in, in CSS px. */
export interface ToastPlacement {
  left: number;
  right: number;
  top: number;
  bottom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export class ToastHostPage {
  /** The stack itself. */
  readonly host: Locator;
  /** Every dashboard notice in the stack (git refusals, errors). */
  readonly notices: Locator;
  readonly infoNotices: Locator;
  readonly errorNotices: Locator;
  readonly warningNotices: Locator;
  /** The "Install band CLI" and "Install Claude Code hooks" notifications. */
  readonly cliNotice: Locator;
  readonly hooksNotice: Locator;
  /** Everything the dashboard renders outside the stack under the old banner ids. */
  readonly sidebarBanners: Locator;
  /** The dialog a long notice's "More" button opens. */
  readonly detailsDialog: Locator;

  constructor(private readonly page: Page) {
    this.host = page.getByTestId("toast-host");
    this.notices = this.host.getByTestId(/^toast-host__notice--(info|warning|error)$/);
    this.infoNotices = this.host.getByTestId("toast-host__notice--info");
    this.errorNotices = this.host.getByTestId("toast-host__notice--error");
    this.warningNotices = this.host.getByTestId("toast-host__notice--warning");
    this.cliNotice = this.host.getByTestId("cli-banner");
    this.hooksNotice = this.host.getByTestId("hooks-banner");
    this.sidebarBanners = page.locator(
      '[data-testid="cli-banner"]:not([data-testid="toast-host"] *), [data-testid="hooks-banner"]:not([data-testid="toast-host"] *)',
    );
    this.detailsDialog = page.getByRole("dialog");
  }

  /** Open the details dialog of the first error notice. */
  async openErrorDetails(): Promise<void> {
    await test.step("Open the error notice's details", async () => {
      await this.errorNotices.first().getByRole("button", { name: "More" }).click();
    });
  }

  /**
   * Closes the CLI and hooks setup notifications whenever one appears, so it cannot cover the
   * right-hand panel a spec clicks in. A spec about the notifications themselves does not call this.
   */
  async closeSetupNoticesWhenShown(): Promise<void> {
    for (const notice of [this.cliNotice, this.hooksNotice]) {
      await this.page.addLocatorHandler(notice, async () => {
        await this.closeButton(notice).click();
      });
    }
  }

  /** The close button of `toast`. */
  closeButton(toast: Locator): Locator {
    return toast.getByRole("button", { name: "Close" });
  }

  /** Where `toast` sits on screen. */
  async readPlacement(toast: Locator): Promise<ToastPlacement> {
    const box = await toast.boundingBox();
    if (!box) throw new Error("toast is not rendered");
    const viewport = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    return {
      left: box.x,
      right: box.x + box.width,
      top: box.y,
      bottom: box.y + box.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    };
  }
}
