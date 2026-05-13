/**
 * Shared controls for the browser pane chrome.
 *
 * `BrowserPanelComponent` (legacy workspace-keyed) and
 * `BrowserPaneComponent` (multi-tab browserId-keyed) need the same
 * behaviour around the address bar, find bar, DevTools toggle, and
 * pane-scoped keyboard shortcuts. This hook owns that surface so the
 * two variants stop drifting:
 *
 *   - `find` — the `useBrowserFindInPage` state machine for this tab.
 *   - `handleAddressFocus` / `handleAddressBlur` — manage the
 *     focused-input ref so `browser-url-changed` events don't clobber
 *     an in-progress edit, and snap the input back to `currentUrl` on
 *     blur.
 *   - `handleAddressKeyDown` — Enter submits via `onNavigate`; Escape
 *     restores `currentUrlRef`, re-selects the input, keeps focus.
 *   - `handlePaneKeyDown` — opens the find bar on Cmd/Ctrl+F when DOM
 *     focus is somewhere inside the pane chrome.
 *   - `handleToggleDevTools` — wires the wrench button to the
 *     `browser_toggle_dev_tools` IPC.
 *   - `paneDataAttrs` — `data-band-browser-pane-*` attributes that
 *     `__bandReload` / `__bandZoom` walk up from `document.activeElement`
 *     to identify which tab to act on.
 *
 * No-op outside the Electron desktop shell.
 */

import { useCallback, useRef } from "react";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import {
  type BrowserKeyName,
  type UseBrowserFindInPageReturn,
  useBrowserFindInPage,
} from "./useBrowserFindInPage";

export interface UseBrowserPaneControlsArgs {
  /** Opaque LRU key of the underlying WebContentsView. */
  key: string;
  /** Whether `key` is a multi-tab `browserId` or a legacy `workspaceId`. */
  keyName: BrowserKeyName;
  /** Latest committed URL (for Escape restore). Ref so `setInputUrl`
   *  reads the current value, not a stale closure. */
  currentUrlRef: React.RefObject<string>;
  /** Address-bar input setter. */
  setInputUrl: (s: string) => void;
  /** Address-bar input value (passed to `onNavigate` on Enter). */
  inputUrl: string;
  /** Called when the user submits the address bar (Enter). */
  onNavigate: (url: string) => void;
}

export interface UseBrowserPaneControlsReturn {
  find: UseBrowserFindInPageReturn;
  /** Set to `true` while the address-bar input has focus. */
  addressInputFocusedRef: React.RefObject<boolean>;
  handleAddressFocus: (e: React.FocusEvent<HTMLInputElement>) => void;
  handleAddressBlur: () => void;
  handleAddressKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handlePaneKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleToggleDevTools: () => Promise<void>;
  /** Spread onto the pane's root `<div>` so the desktop menu's
   *  contextual Cmd+R / Cmd+= can locate this pane via
   *  `document.activeElement.closest("[data-band-browser-pane]")`. */
  paneDataAttrs: {
    "data-band-browser-pane": "";
    "data-band-browser-pane-key": string;
    "data-band-browser-pane-keyname": BrowserKeyName;
  };
}

export function useBrowserPaneControls(
  args: UseBrowserPaneControlsArgs,
): UseBrowserPaneControlsReturn {
  const { key, keyName, currentUrlRef, setInputUrl, inputUrl, onNavigate } = args;

  const find = useBrowserFindInPage({ key, keyName });
  const addressInputFocusedRef = useRef(false);

  const handleAddressFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    addressInputFocusedRef.current = true;
    e.target.select();
  }, []);

  const handleAddressBlur = useCallback(() => {
    addressInputFocusedRef.current = false;
    // Re-sync to the latest committed URL in case events fired (and
    // were ignored) while we were focused. Matches Chrome: typed-but-
    // not-submitted URLs revert on blur.
    setInputUrl(currentUrlRef.current);
  }, [currentUrlRef, setInputUrl]);

  const handleAddressKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onNavigate(inputUrl);
        return;
      }
      // Escape abandons an in-progress edit and snaps the input back
      // to the canonical URL with the whole value re-selected — same
      // as Chrome's address bar. Keep focus so the user can type to
      // replace without re-clicking the bar.
      if (e.key === "Escape") {
        e.preventDefault();
        setInputUrl(currentUrlRef.current);
        const input = e.currentTarget;
        // Defer past the React commit so we select against the
        // restored value (setting `input.value` mid-render would clear
        // any selection we made here). Guard with `isConnected` because
        // the component may unmount between Escape and the next frame
        // (e.g. user closes the workspace immediately after pressing
        // Escape) — calling `.select()` on a detached element throws.
        requestAnimationFrame(() => {
          if (input.isConnected) input.select();
        });
      }
    },
    [inputUrl, onNavigate, setInputUrl, currentUrlRef],
  );

  const handlePaneKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key.toLowerCase() !== "f") return;
      if (e.shiftKey || e.altKey) return;
      // `navigator.platform` is deprecated (Chrome 113+ planned-removal);
      // use the UA string which still reliably contains "Mac" on macOS.
      const isMac = /mac/i.test(navigator.userAgent);
      const wantsFind = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!wantsFind) return;
      e.preventDefault();
      e.stopPropagation();
      find.open();
    },
    [find],
  );

  const handleToggleDevTools = useCallback(async () => {
    if (!isDesktop) return;
    try {
      await desktopInvoke("browser_toggle_dev_tools", { [keyName]: key });
    } catch (e) {
      console.error("browser_toggle_dev_tools failed:", e);
    }
  }, [key, keyName]);

  return {
    find,
    addressInputFocusedRef,
    handleAddressFocus,
    handleAddressBlur,
    handleAddressKeyDown,
    handlePaneKeyDown,
    handleToggleDevTools,
    paneDataAttrs: {
      "data-band-browser-pane": "",
      "data-band-browser-pane-key": key,
      "data-band-browser-pane-keyname": keyName,
    },
  };
}
