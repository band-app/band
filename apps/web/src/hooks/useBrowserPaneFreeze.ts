/**
 * Shared freeze-on-overlay effect for browser panes.
 *
 * Extracted from `BrowserPanel.tsx` so the multi-tab
 * (`BrowserPaneComponent`, browserId-keyed) and legacy
 * (`BrowserPanelComponent`, workspaceId-keyed) variants don't carry
 * a copy each. The two were drifting before this extraction (e.g.
 * different `isVisible` semantics) and any future change to the
 * freeze flow — DevTools-aware capture, media-pause ordering,
 * etc. — would have had to be made in two places.
 *
 * What it does:
 *
 *   1. When the global freeze store flips on (any Radix overlay
 *      opens, or any caller invokes `useFreezeWhile`), capture a
 *      JPEG snapshot of the live page via `browser_capture_page`,
 *      paint it as the returned `snapshot` data URL (the caller
 *      is expected to render an `<img>` over its placeholder),
 *      then pause media + hide the native view.
 *
 *   2. When the freeze store flips off, restore: show the native
 *      view, resume media, then drop the snapshot after one paint
 *      so the native view comes back on top before the `<img>` is
 *      removed.
 *
 *   3. Skip both directions if the pane is not currently visible
 *      (inactive dockview tab, inactive workspace). `freezeApplied`
 *      tracks the decision so the unfreeze path only restores
 *      panes we actually hid.
 *
 *   4. `flushSync` + double-rAF on freeze ensures the `<img>` paints
 *      before the OS view is hidden — without it the swap flickers
 *      for one frame. The symmetric one-rAF defer on unfreeze
 *      keeps the snapshot visible until the OS view is repainted.
 */

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useBrowserPaneFrozen } from "../lib/browser-pane-freeze";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

/**
 * Wait for the browser to paint at least one frame after the
 * current React commit. Double-rAF is the canonical idiom: the
 * first rAF fires before paint, the second after. We use this so
 * the snapshot `<img>` is actually on screen before we hide the
 * native `WebContentsView` — otherwise the OS can hide the view a
 * frame before React paints, briefly exposing the blank
 * placeholder underneath.
 */
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export interface UseBrowserPaneFreezeArgs {
  /** Set to `true` once the native view has been created and is
   *  ready to be captured / hidden. */
  created: boolean;
  /**
   * Whether this pane is currently visible to the user — gates the
   * whole freeze/unfreeze cycle. The multi-tab pane reads
   * `api.isVisible`; the legacy single-pane reads `api.isActive`.
   * Either way, when false we leave the native view untouched so
   * the unfreeze path can't accidentally surface a tab the user
   * has navigated away from.
   */
  visible: boolean;
  /**
   * IPC payload that addresses this pane. The multi-tab variant
   * passes `{ browserId }`; the legacy variant passes
   * `{ workspaceId }`. Either is accepted by the browser_* IPCs.
   * Kept as a ref to avoid re-running the effect when the id
   * changes — the actual freeze decision is gated on `frozen`.
   */
  ipcKeyRef: React.RefObject<{ browserId?: string; workspaceId?: string }>;
}

export interface UseBrowserPaneFreezeResult {
  /** JPEG data URL of the last-captured frame, or null when not
   *  frozen. Render as an `<img>` over the placeholder. */
  snapshot: string | null;
}

export function useBrowserPaneFreeze(args: UseBrowserPaneFreezeArgs): UseBrowserPaneFreezeResult {
  const { created, visible, ipcKeyRef } = args;
  const frozen = useBrowserPaneFrozen();
  const [snapshot, setSnapshot] = useState<string | null>(null);
  // Tracks whether we actually applied the freeze on this pane.
  // Needed so the unfreeze path only restores panes we hid — for
  // panes that were already hidden when `frozen` flipped (inactive
  // dockview tab, hidden workspace), calling `browser_show` would
  // wrongly surface them over the user's chosen tab.
  const freezeAppliedRef = useRef(false);

  useEffect(() => {
    if (!isDesktop || !created) return;
    let cancelled = false;

    if (frozen) {
      if (!visible) return; // hidden pane — leave alone
      const ipcKey = ipcKeyRef.current;
      (async () => {
        try {
          const dataUrl = await desktopInvoke<string | null>("browser_capture_page", ipcKey);
          if (!cancelled && dataUrl) {
            // flushSync commits the snapshot to the DOM synchronously
            // so the <img> is in the tree by the time we yield.
            // waitForPaint guarantees the browser has actually
            // painted the image before we hide the native view —
            // otherwise the OS view disappears a frame before the
            // <img> is on screen, producing a flicker.
            flushSync(() => setSnapshot(dataUrl));
            await waitForPaint();
          }
        } catch {
          // ignore — fall back to a blank placeholder
        }
        if (cancelled) return;
        // Mark "we hid this pane" only AFTER we've crossed the
        // cancellation check and are about to actually call
        // `browser_hide`. Setting it earlier would race: if the
        // overlay closed mid-capture, the cleanup would set
        // `cancelled = true` and the next effect run (with
        // `frozen=false`) would see the ref already `true` and call
        // `browser_show` on a pane we never hid — potentially
        // surfacing a tab the user hadn't chosen.
        freezeAppliedRef.current = true;
        // Capture happened FIRST so the snapshot reflects the live
        // frame; now pause media (audio mute + JS pause sweep) and
        // hide the native view. `setVisible(false)` alone doesn't
        // stop audio playback — see `BrowserViewManager.pauseMedia`.
        desktopInvoke("browser_pause_media", ipcKey).catch(() => {});
        desktopInvoke("browser_hide", ipcKey).catch(() => {});
      })();
    } else {
      if (freezeAppliedRef.current) {
        freezeAppliedRef.current = false;
        const ipcKey = ipcKeyRef.current;
        desktopInvoke("browser_show", ipcKey).catch(() => {});
        // Resume after show so the page is visible by the time
        // `play()` lands — avoids a brief audio-before-video flash.
        desktopInvoke("browser_resume_media", ipcKey).catch(() => {});
        // Keep the snapshot up for one more paint so the native view
        // gets a chance to come back on top before the snapshot is
        // removed. Otherwise React commits the `null` clear before
        // the OS compositor has the view visible again, briefly
        // exposing a blank placeholder.
        (async () => {
          await waitForPaint();
          if (!cancelled) setSnapshot(null);
        })();
      } else {
        setSnapshot(null);
      }
    }

    return () => {
      cancelled = true;
    };
    // ipcKeyRef is stable (it's a ref); the deps that actually
    // gate the effect are `frozen`, `created`, and `visible`.
  }, [frozen, created, visible, ipcKeyRef]);

  return { snapshot };
}
