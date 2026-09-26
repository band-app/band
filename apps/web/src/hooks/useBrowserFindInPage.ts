/**
 * Find-in-page state machine for a single browser pane.
 *
 * Behaviour:
 *   - Owns `query`, `options`, `matchInfo`, and `isOpen` state.
 *   - On query / case-toggle changes, calls the tab's
 *     `webview.findInPage` so Chromium re-runs its native scan and
 *     re-paints the highlights.
 *   - `findNext` / `findPrevious` reuse the cached match set
 *     (`{ findNext: true }`) instead of rescanning.
 *   - Reads back the webview's `found-in-page` events to drive the match
 *     counter ("3 of 12"). Intermediate updates are shown immediately;
 *     `finalUpdate: true` is just the authoritative total.
 *   - Closes itself when the tab starts a new main-frame navigation —
 *     matches the "the find bar resets when … navigating away"
 *     requirement without persisting anything.
 *
 * Cmd/Ctrl+F typed inside the page reaches the pane's keydown handler as a
 * forwarded shortcut (`browser-guest-shortcut`), so no extra listener is
 * needed here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchBarHandle, SearchOptions } from "@/dashboard";
import type { BrowserWebview, WebviewFoundInPageResult } from "../lib/browser-webview";

export interface UseBrowserFindInPageReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  query: string;
  setQuery: (q: string) => void;
  options: SearchOptions;
  setOptions: (o: SearchOptions) => void;
  /** `{ total, current }` (1-indexed), or `null` while there is no result yet. */
  matchInfo: { total: number; current: number } | null;
  findNext: () => void;
  findPrevious: () => void;
  /** Pass to `<SearchBar ref={...} />` to enable focus/select on open. */
  searchBarRef: React.RefObject<SearchBarHandle | null>;
}

/**
 * `SearchOptions` is shared with other search bars in the app (file
 * search, diff search, etc.), which need all three toggles. Browser
 * find-in-page only honours `caseSensitive` — Chromium's
 * `findInPage` API does not expose whole-word or regex
 * mode. `BrowserFindBar` therefore renders only the case-sensitive
 * toggle (`visibleOptions={["caseSensitive"]}`); `wholeWord` and
 * `regex` are accepted on the type but silently ignored here.
 *
 * If a future caller flips them on (e.g. a test or programmatic
 * usage), the search will NOT re-fire — `issueFind` only depends on
 * `options.caseSensitive` — and the result set won't change. This is
 * intentional: silently dropping the unsupported toggles is more
 * honest than pretending to honour them.
 */
const DEFAULT_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/**
 * `webview` is the tab's page element, or null while the pane has none
 * (not created yet, or evicted by the hidden-workspace budget).
 */
export function useBrowserFindInPage(webview: BrowserWebview | null): UseBrowserFindInPageReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [matchInfo, setMatchInfo] = useState<{ total: number; current: number } | null>(null);

  const searchBarRef = useRef<SearchBarHandle>(null);
  const webviewRef = useRef(webview);
  webviewRef.current = webview;
  /**
   * The `requestId` returned by the most recent `findInPage` call.
   * Chromium can keep emitting `found-in-page` events for a cancelled
   * request after the next request has already started; the stale match
   * counter would briefly overwrite the new one. Filtering the listener by
   * `requestId` discards those late stragglers.
   */
  const activeRequestIdRef = useRef<number | null>(null);

  const focusInput = useCallback(() => {
    // Defer so the input is mounted before we try to focus it (the
    // SearchBar only renders when `isOpen` flips to true).
    requestAnimationFrame(() => {
      searchBarRef.current?.focus();
      searchBarRef.current?.select();
    });
  }, []);

  const stopFind = useCallback(() => {
    try {
      webviewRef.current?.stopFindInPage("clearSelection");
    } catch {
      // best-effort — the guest may not be attached yet or already gone
    }
  }, []);

  const issueFind = useCallback(
    (text: string, opts: { findNext?: boolean; forward?: boolean } = {}): void => {
      if (!text) {
        setMatchInfo(null);
        // Forget the in-flight request so any straggling `found-in-page`
        // events for it are dropped by the listener.
        activeRequestIdRef.current = null;
        stopFind();
        return;
      }
      // When starting a brand-new scan (not just stepping through the
      // existing match set), clear the stale counter from the previous
      // query so the UI doesn't briefly flash the old "3 of 12" while the
      // new scan is in flight. Stepping (`findNext: true`) reuses the
      // previous result set so the counter stays accurate.
      if (!(opts.findNext ?? false)) {
        setMatchInfo(null);
        activeRequestIdRef.current = null;
      }
      const target = webviewRef.current;
      if (!target) return;
      try {
        activeRequestIdRef.current = target.findInPage(text, {
          matchCase: options.caseSensitive,
          // First search for a query → omit findNext so Chromium rescans.
          // Stepping → set findNext: true and toggle forward.
          findNext: opts.findNext ?? false,
          forward: opts.forward ?? true,
        });
      } catch (e) {
        console.error("findInPage failed:", e);
      }
    },
    [options.caseSensitive, stopFind],
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setMatchInfo(null);
    activeRequestIdRef.current = null;
    stopFind();
  }, [stopFind]);

  const open = useCallback(() => {
    setIsOpen(true);
    focusInput();
  }, [focusInput]);

  // Re-issue the search whenever the query or case toggle changes while
  // the bar is open.
  useEffect(() => {
    if (!isOpen) return;
    issueFind(query);
  }, [query, isOpen, issueFind]);

  useEffect(() => {
    if (!webview) return;
    const onFound = (event: Event) => {
      const result = (event as Event & { result: WebviewFoundInPageResult }).result;
      if (activeRequestIdRef.current !== null && result.requestId !== activeRequestIdRef.current) {
        return;
      }
      setMatchInfo({ total: result.matches, current: result.activeMatchOrdinal });
    };
    // A new main-frame document invalidates the match set; close the bar.
    const onNavigate = (event: Event) => {
      const nav = event as Event & { isMainFrame: boolean; isInPlace: boolean };
      if (nav.isMainFrame && !nav.isInPlace) close();
    };
    webview.addEventListener("found-in-page", onFound);
    webview.addEventListener("did-start-navigation", onNavigate);
    return () => {
      webview.removeEventListener("found-in-page", onFound);
      webview.removeEventListener("did-start-navigation", onNavigate);
    };
  }, [webview, close]);

  const findNext = useCallback(() => {
    if (!query) return;
    issueFind(query, { findNext: true, forward: true });
  }, [query, issueFind]);

  const findPrevious = useCallback(() => {
    if (!query) return;
    issueFind(query, { findNext: true, forward: false });
  }, [query, issueFind]);

  return {
    isOpen,
    open,
    close,
    query,
    setQuery,
    options,
    setOptions,
    matchInfo,
    findNext,
    findPrevious,
    searchBarRef,
  };
}
