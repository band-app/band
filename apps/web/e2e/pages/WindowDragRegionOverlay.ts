/**
 * Component object for the window drag region overlay
 * (`apps/web/src/components/WindowDragRegionOverlay.tsx`), toggled from the
 * command palette ("Toggle Window Drag Region Overlay").
 *
 * Locators key off the `data-testid` hooks the component sets:
 *   - `drag-region-overlay`                    — the overlay root
 *   - `drag-region-overlay__rect--drag`        — one drag rect
 *   - `drag-region-overlay__rect--no-drag`     — one no-drag rect
 *   - `drag-region-overlay__covered`           — a control a drag rect covers
 *
 * Takes only `page`, like `CommandPalette`: the overlay has no URL of its own.
 */

import type { Locator, Page } from "@playwright/test";

export class WindowDragRegionOverlay {
  readonly root: Locator;
  readonly dragRects: Locator;
  readonly noDragRects: Locator;
  readonly coveredControls: Locator;

  constructor(page: Page) {
    this.root = page.getByTestId("drag-region-overlay");
    this.dragRects = page.getByTestId("drag-region-overlay__rect--drag");
    this.noDragRects = page.getByTestId("drag-region-overlay__rect--no-drag");
    this.coveredControls = page.getByTestId("drag-region-overlay__covered");
  }
}
