/**
 * Chrome controls for `BrowserPaneComponent` (one browser tab, keyed by
 * `browserId`): the address bar, find bar, DevTools toggle, and
 * pane-scoped keyboard shortcuts.
 *
 *   - `find` — the `useBrowserFindInPage` state machine for this tab.
 *   - `handleAddressFocus` / `handleAddressBlur` — manage the
 *     focused-input ref so `browser-url-changed` events don't clobber
 *     an in-progress edit, and snap the input back to `currentUrl` on
 *     blur.
 *   - `handleAddressKeyDown` — Enter submits via `onNavigate`; Escape
 *     restores `currentUrlRef`, re-selects the input, keeps focus.
 *     Arrow keys steer the history autocomplete dropdown when it is
 *     open.
 *   - `handlePaneKeyDown` — opens the find bar on Cmd/Ctrl+F when DOM
 *     focus is somewhere inside the pane, including the page (the key
 *     arrives as a forwarded shortcut dispatched on the `<webview>`).
 *   - `devToolsOpen` / `handleToggleDevTools` — whether the pane shows its
 *     docked DevTools split; the pane wires the split to the main process.
 *   - `paneDataAttrs` — `data-band-browser-pane-*` attributes that
 *     `__bandReload` / `__bandZoom` walk up from `document.activeElement`
 *     to identify which tab to act on.
 *   - `autocomplete` — history-backed URL suggestions that show up
 *     while the address bar is focused with a non-empty value.
 *
 * Only mounted in the Electron desktop shell.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserWebview } from "../lib/browser-webview";
import { trpc } from "../lib/trpc-client";
import { type UseBrowserFindInPageReturn, useBrowserFindInPage } from "./useBrowserFindInPage";

export interface AutocompleteEntry {
  id: number;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  visitCount: number;
}

export interface AutocompleteState {
  isOpen: boolean;
  items: AutocompleteEntry[];
  selectedIndex: number;
  /** Imperatively close — e.g. after a successful navigation. */
  close: () => void;
  /** Mouse hover handler — keeps keyboard/mouse selection in sync. */
  setSelectedIndex: (i: number) => void;
}

export interface UseBrowserPaneControlsArgs {
  /** Band browser tab id. */
  browserId: string;
  /** The tab's page element, or null while the pane has none. */
  webview: BrowserWebview | null;
  /** Workspace this pane belongs to. Drives history autocomplete scope. */
  workspaceId: string;
  /** Latest committed URL (for Escape restore). Ref so `setInputUrl`
   *  reads the current value, not a stale closure. */
  currentUrlRef: React.RefObject<string>;
  /** Address-bar input setter. */
  setInputUrl: (s: string) => void;
  /** Address-bar input value (passed to `onNavigate` on Enter). */
  inputUrl: string;
  /** Called when the user submits the address bar (Enter) or picks a
   *  history suggestion. */
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
  /** Whether the docked DevTools split is open. */
  devToolsOpen: boolean;
  setDevToolsOpen: (open: boolean) => void;
  handleToggleDevTools: () => void;
  autocomplete: AutocompleteState;
  /** Spread onto the pane's root `<div>` so the desktop menu's
   *  contextual Cmd+R / Cmd+= can locate this pane via
   *  `document.activeElement.closest("[data-band-browser-pane]")`. */
  paneDataAttrs: {
    "data-band-browser-pane": "";
    "data-band-browser-pane-key": string;
  };
}

// How long after the user stops typing before we hit `history.search`.
// 50ms feels instantaneous and avoids hammering the DB on every
// keystroke. The search itself is sub-ms for any realistic history
// volume.
const AUTOCOMPLETE_DEBOUNCE_MS = 50;
// Delay between blur and close, so a click on a dropdown row commits
// before the dropdown disappears.
const AUTOCOMPLETE_BLUR_CLOSE_MS = 100;

export function useBrowserPaneControls(
  args: UseBrowserPaneControlsArgs,
): UseBrowserPaneControlsReturn {
  const { browserId, webview, workspaceId, currentUrlRef, setInputUrl, inputUrl, onNavigate } =
    args;

  const find = useBrowserFindInPage(webview);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const addressInputFocusedRef = useRef(false);

  // ------- Autocomplete state -------
  const [autocompleteItems, setAutocompleteItems] = useState<AutocompleteEntry[]>([]);
  const [autocompleteIsOpen, setAutocompleteIsOpen] = useState(false);
  const [autocompleteSelectedIndex, setAutocompleteSelectedIndex] = useState(0);

  const closeAutocomplete = useCallback(() => {
    setAutocompleteIsOpen(false);
    setAutocompleteItems([]);
    setAutocompleteSelectedIndex(0);
  }, []);

  // Debounced history search. We only fire when the address bar is
  // focused *and* the input is non-empty — typing a URL bar query
  // mid-page shouldn't open a phantom dropdown.
  useEffect(() => {
    if (!addressInputFocusedRef.current) return;
    const trimmed = inputUrl.trim();
    if (trimmed === "") {
      closeAutocomplete();
      return;
    }
    // Skip the search call if the input is exactly the committed URL —
    // happens when the user focuses the bar without typing, or hits
    // Escape and the value is restored. Saves a roundtrip for the most
    // common case.
    if (trimmed === currentUrlRef.current.trim()) {
      closeAutocomplete();
      return;
    }

    let cancelled = false;
    const handle = setTimeout(() => {
      trpc.history.search
        .query({ workspaceId, query: trimmed, limit: 8 })
        .then((result) => {
          if (cancelled) return;
          if (result.entries.length === 0) {
            closeAutocomplete();
            return;
          }
          setAutocompleteItems(result.entries);
          setAutocompleteIsOpen(true);
          setAutocompleteSelectedIndex(0);
        })
        .catch(() => {
          // Server unreachable / shutting down — silently close.
          if (!cancelled) closeAutocomplete();
        });
    }, AUTOCOMPLETE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [inputUrl, workspaceId, closeAutocomplete, currentUrlRef]);

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
    // Defer close so an `onMouseDown` on a dropdown row gets a chance
    // to trigger `onNavigate` before its parent unmounts. Re-check
    // focus before actually closing: if the user blurred and
    // refocused inside the debounce window (e.g. quick tab-switch
    // away and back), keep the dropdown up.
    setTimeout(() => {
      if (!addressInputFocusedRef.current) closeAutocomplete();
    }, AUTOCOMPLETE_BLUR_CLOSE_MS);
  }, [currentUrlRef, setInputUrl, closeAutocomplete]);

  const handleAddressKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // ----- Autocomplete keyboard navigation -----
      if (autocompleteIsOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAutocompleteSelectedIndex((i) => Math.min(i + 1, autocompleteItems.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAutocompleteSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          const selected = autocompleteItems[autocompleteSelectedIndex];
          if (selected) {
            e.preventDefault();
            closeAutocomplete();
            onNavigate(selected.url);
            return;
          }
        }
        if (e.key === "Escape") {
          // First Escape closes the dropdown; if the user hits it again
          // we fall through to the canonical-URL restore below.
          e.preventDefault();
          closeAutocomplete();
          return;
        }
      }

      if (e.key === "Enter") {
        e.preventDefault();
        closeAutocomplete();
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
    [
      inputUrl,
      onNavigate,
      setInputUrl,
      currentUrlRef,
      autocompleteIsOpen,
      autocompleteItems,
      autocompleteSelectedIndex,
      closeAutocomplete,
    ],
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

  const handleToggleDevTools = useCallback(() => setDevToolsOpen((open) => !open), []);

  return {
    find,
    addressInputFocusedRef,
    handleAddressFocus,
    handleAddressBlur,
    handleAddressKeyDown,
    handlePaneKeyDown,
    devToolsOpen,
    setDevToolsOpen,
    handleToggleDevTools,
    autocomplete: {
      isOpen: autocompleteIsOpen,
      items: autocompleteItems,
      selectedIndex: autocompleteSelectedIndex,
      close: closeAutocomplete,
      setSelectedIndex: setAutocompleteSelectedIndex,
    },
    paneDataAttrs: {
      "data-band-browser-pane": "",
      "data-band-browser-pane-key": browserId,
    },
  };
}
