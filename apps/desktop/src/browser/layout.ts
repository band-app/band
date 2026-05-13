/**
 * Pure layout math for the browser pane's tab bounds, extracted so the
 * splitting logic can be exercised in isolation (no Electron import).
 *
 * `BrowserViewManager` owns the side-effectful `setBounds` calls; this
 * module just computes "given a tab's outer bounds, what bounds should
 * the page view and the (optional) docked DevTools sibling each get?".
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitOptions {
  /** Fraction of `bounds.height` the DevTools strip wants by default. */
  splitRatio: number;
  /** Minimum height the DevTools strip prefers to keep, when there's room. */
  devMinHeight: number;
  /** Minimum height the page view should never collapse below. */
  pageMinHeight: number;
}

export interface SplitResult {
  /** Page view bounds (top portion when DevTools is open). */
  page: Rect;
  /** DevTools sibling bounds (bottom portion). Always set; callers
   *  ignore it when no DevTools sibling exists. */
  dev: Rect;
}

/**
 * Split a tab's outer bounds between the page view (top) and the
 * docked DevTools sibling (bottom).
 *
 * Invariants the test suite covers:
 *
 *   - `page.height + dev.height === bounds.height` for any non-negative
 *     `bounds.height` — the two pieces always sum to the original, no
 *     overflow even on short windows where the clamps would otherwise
 *     overlap.
 *   - `page.height >= min(pageMinHeight, bounds.height)` when the
 *     window has any room at all.
 *   - `dev.height >= min(devMinHeight, bounds.height - pageMinHeight)`
 *     when there's room; otherwise DevTools is sacrificed to keep the
 *     page view at its minimum.
 *   - `page` and `dev` together cover exactly `bounds` (no gap, no
 *     overlap).
 */
export function splitTabBounds(bounds: Rect, options: SplitOptions): SplitResult {
  const { splitRatio, devMinHeight, pageMinHeight } = options;
  const rawDevHeight = Math.round(bounds.height * splitRatio);
  const maxDevHeight = Math.max(0, bounds.height - pageMinHeight);
  const clampedMin = Math.min(devMinHeight, maxDevHeight);
  const devHeight = Math.min(maxDevHeight, Math.max(clampedMin, rawDevHeight));
  const pageHeight = Math.max(0, bounds.height - devHeight);
  return {
    page: { x: bounds.x, y: bounds.y, width: bounds.width, height: pageHeight },
    dev: {
      x: bounds.x,
      y: bounds.y + pageHeight,
      width: bounds.width,
      height: devHeight,
    },
  };
}
