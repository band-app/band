import { useEffect, useState } from "react";

/**
 * Pixel height the accessory toolbar occupies on screen. Derived from its
 * Tailwind classes: the row is `py-1.5` (12px total padding) + `h-9` buttons
 * (36px), plus a 1px `border-t`. Kept in sync with TerminalToolbar.tsx by
 * convention. Used by consumers (TerminalPanel) to reserve a matching strip
 * of bottom inset so their content isn't covered by the floating bar.
 *
 * If you change the toolbar's vertical sizing, update this constant too.
 */
export const TERMINAL_TOOLBAR_HEIGHT_PX = 49;

/**
 * Detects whether to render a "virtual keyboard accessory" toolbar (iOS-style
 * row of helper keys above the soft keyboard) and where to position it.
 *
 * Returns:
 * - `enabled`: true on touch-only devices (no hover + coarse pointer). This
 *   covers iPhones/iPads in Safari and other mobile browsers. Desktop browsers
 *   (including those with touchscreens *plus* a mouse) return false, so the
 *   toolbar stays out of the way per the acceptance criteria in issue #390.
 * - `bottomOffset`: how many pixels above the bottom of the layout viewport the
 *   toolbar should sit. When the virtual keyboard is open, the VisualViewport
 *   API reports a smaller `height` + nonzero `offsetTop`; the difference vs
 *   `window.innerHeight` is the keyboard's pixel height. When the keyboard is
 *   closed, this is 0 and the toolbar pins to the bottom of the screen.
 * - `contentBottomInset`: how many pixels the *terminal content* should
 *   reserve at the bottom so it isn't hidden beneath the floating toolbar.
 *   Equal to the toolbar height when `enabled`, else 0. The toolbar itself
 *   is `position: fixed`, so without this reservation a panel that reaches
 *   the bottom of the visual viewport (the common iOS layout — the workspace
 *   already shrinks to `visualViewport.height`) would render its bottom rows
 *   underneath the bar, hiding the prompt/cursor while typing.
 *
 * Why VisualViewport and not `env(keyboard-inset-height)`: the CSS env var is
 * iOS 17+ and still flaky in PWAs / WKWebView. The VisualViewport API has
 * shipped in iOS Safari since 13 and is the same primitive `useAppHeight`
 * elsewhere in this app already relies on.
 */
export interface VirtualKeyboardToolbarState {
  enabled: boolean;
  bottomOffset: number;
  contentBottomInset: number;
}

const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

export function useVirtualKeyboardToolbar(): VirtualKeyboardToolbarState {
  const [enabled, setEnabled] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(TOUCH_QUERY).matches,
  );
  const [bottomOffset, setBottomOffset] = useState(0);

  // Track touch-only device status. Used to gate the toolbar entirely so it
  // never paints on desktop, where the virtual keyboard never exists.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(TOUCH_QUERY);
    const handler = (e: MediaQueryListEvent) => setEnabled(e.matches);
    // Sync the initial value too — covers the SSR/hydration mismatch case.
    setEnabled(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Track the keyboard's pixel height via the VisualViewport API. We listen to
  // both `resize` (fires when the keyboard slides in/out) and `scroll` (fires
  // while the user scrolls the page-with-keyboard-open, which shifts
  // `offsetTop` and can otherwise leave the toolbar floating mid-screen).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!enabled) {
      setBottomOffset(0);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Keyboard occupies the gap between the bottom of the visual viewport
      // (`vv.offsetTop + vv.height`) and the bottom of the layout viewport
      // (`window.innerHeight`). Clamp to non-negative so a stale measurement
      // during orientation change can't push the toolbar off-screen.
      const keyboardHeight = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
      setBottomOffset(keyboardHeight);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);

  return {
    enabled,
    bottomOffset,
    contentBottomInset: enabled ? TERMINAL_TOOLBAR_HEIGHT_PX : 0,
  };
}
