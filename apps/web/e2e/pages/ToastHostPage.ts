/**
 * Page object for the bottom-right toast stack (`ToastHost`), which holds the
 * app update toast, the Home Screen notice and the dashboard's notices. The
 * `data-testid`s are set in `ToastHost.tsx` and `ToastCard.tsx`.
 */

import type { Locator, Page } from "@playwright/test";

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

  constructor(private readonly page: Page) {
    this.host = page.getByTestId("toast-host");
    this.notices = this.host.getByTestId("toast-host__notice");
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
