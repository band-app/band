/**
 * Find-in-page state machine for a single browser pane.
 *
 * The hook is shared by both browser-pane variants (`BrowserPanelComponent`,
 * keyed by `workspaceId`, and the multi-tab `BrowserPaneComponent`, keyed by
 * `browserId`). Pass whichever identifier the pane uses; the hook scopes
 * its IPC subscriptions accordingly.
 *
 * Behaviour:
 *   - Owns `query`, `options`, `matchInfo`, and `isOpen` state.
 *   - On query / case-toggle changes, calls `browser_find_in_page` so
 *     Chromium re-runs its native scan and re-paints the highlights.
 *   - `findNext` / `findPrevious` reuse the cached match set
 *     (`{ findNext: true }`) instead of rescanning.
 *   - Reads back `browser-found-in-page` events to drive the match
 *     counter ("3 of 12"). Intermediate updates are shown immediately;
 *     `final_update: true` is just the authoritative total.
 *   - Reacts to the main-process `browser-find-shortcut` event so the
 *     shortcut works even when keyboard focus is inside the
 *     `WebContentsView` (where the renderer's DOM keydown listener never
 *     fires).
 *   - Closes itself when the tab navigates to a new URL — matches the
 *     "the find bar resets when … navigating away" requirement without
 *     persisting anything.
 *
 * No-op outside the Electron desktop shell.
 */

import type { SearchBarHandle, SearchOptions } from "@band-app/dashboard-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

export type BrowserKeyName = "browserId" | "workspaceId";

export interface UseBrowserFindInPageArgs {
  /** The opaque LRU key of the underlying WebContentsView. */
  key: string;
  /** Whether `key` is a multi-tab `browserId` or a legacy `workspaceId`. */
  keyName: BrowserKeyName;
}

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
 * `webContents.findInPage` API does not expose whole-word or regex
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

interface FoundInPagePayload {
  browser_id: string;
  workspace_id: string;
  request_id: number;
  active_match_ordinal: number;
  matches: number;
  final_update: boolean;
}

interface FindShortcutPayload {
  browser_id: string;
  workspace_id: string;
}

interface UrlChangedPayload {
  browser_id: string;
  workspace_id: string;
  url: string;
  loading: boolean;
}

export function useBrowserFindInPage({
  key,
  keyName,
}: UseBrowserFindInPageArgs): UseBrowserFindInPageReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [matchInfo, setMatchInfo] = useState<{ total: number; current: number } | null>(null);

  const searchBarRef = useRef<SearchBarHandle>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  /**
   * The `requestId` returned by the most recent `webContents.findInPage`
   * call. Chromium can keep emitting `found-in-page` events for a
   * cancelled request after the next request has already started; the
   * stale match counter would briefly overwrite the new one. Filtering
   * the listener by `requestId` discards those late stragglers.
   */
  const activeRequestIdRef = useRef<number | null>(null);

  // Pull the right id field out of an event payload — both fields carry
  // the same value today, but using the renderer's chosen `keyName` keeps
  // the code honest if that ever diverges.
  const payloadKey = useCallback(
    (payload: { browser_id: string; workspace_id: string }): string =>
      keyName === "browserId" ? payload.browser_id : payload.workspace_id,
    [keyName],
  );

  const buildArgs = useCallback(
    (extra: Record<string, unknown> = {}) => ({ [keyName]: keyRef.current, ...extra }),
    [keyName],
  );

  const focusInput = useCallback(() => {
    // Defer so the input is mounted before we try to focus it (the
    // SearchBar only renders when `isOpen` flips to true).
    requestAnimationFrame(() => {
      searchBarRef.current?.focus();
      searchBarRef.current?.select();
    });
  }, []);

  // ---- Issue a findInPage request through the desktop IPC bridge ----
  const issueFind = useCallback(
    async (text: string, opts: { findNext?: boolean; forward?: boolean } = {}): Promise<void> => {
      if (!isDesktop) return;
      if (!text) {
        setMatchInfo(null);
        // Forget the in-flight request so any straggling `found-in-page`
        // events for it are dropped by the listener.
        activeRequestIdRef.current = null;
        try {
          await desktopInvoke("browser_stop_find_in_page", buildArgs({ action: "clearSelection" }));
        } catch {
          // best-effort — the view may already be gone
        }
        return;
      }
      try {
        const reqId = await desktopInvoke<number | undefined>(
          "browser_find_in_page",
          buildArgs({
            text,
            options: {
              matchCase: options.caseSensitive,
              // First search for a query → omit findNext so Chromium
              // rescans. Stepping → set findNext: true and toggle forward.
              findNext: opts.findNext ?? false,
              forward: opts.forward ?? true,
            },
          }),
        );
        // Track the new requestId so the `found-in-page` listener can
        // ignore late events from the previous query.
        if (typeof reqId === "number") activeRequestIdRef.current = reqId;
      } catch (e) {
        // Network is in-process IPC; only fails on shape mismatch /
        // missing handler. Log but don't propagate.
        console.error("browser_find_in_page failed:", e);
      }
    },
    [buildArgs, options.caseSensitive],
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setMatchInfo(null);
    activeRequestIdRef.current = null;
    if (!isDesktop) return;
    desktopInvoke("browser_stop_find_in_page", buildArgs({ action: "clearSelection" })).catch(
      () => {},
    );
  }, [buildArgs]);

  const open = useCallback(() => {
    setIsOpen(true);
    focusInput();
  }, [focusInput]);

  // ---- Re-issue the search whenever the query or case toggle changes ----
  // Debounce-free: Chromium's findInPage already handles rapid succession
  // gracefully (it cancels the prior request before starting a new scan),
  // and the renderer feels snappier without a typing delay.
  useEffect(() => {
    if (!isOpen) return;
    void issueFind(query);
  }, [query, isOpen, issueFind]);

  // ---- Subscribe to streamed `found-in-page` results ----
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await desktopListen<FoundInPagePayload>("browser-found-in-page", (event) => {
        if (payloadKey(event.payload) !== keyRef.current) return;
        // Drop late events from a cancelled request — Chromium can
        // emit them after we've already started a new scan, and the
        // stale `matches` / `activeMatchOrdinal` would briefly flicker
        // into the visible counter.
        if (
          activeRequestIdRef.current !== null &&
          event.payload.request_id !== activeRequestIdRef.current
        ) {
          return;
        }
        setMatchInfo({
          total: event.payload.matches,
          // Chromium reports `0` while a query is being typed and the
          // scan is mid-flight; promote to 0 of N so the UI shows
          // "No results" until a match is selected.
          current: event.payload.active_match_ordinal,
        });
      });
    })();
    return () => unlisten?.();
  }, [payloadKey]);

  // ---- Subscribe to the main-process Cmd+F intercept ----
  // Fired when the WebContentsView itself has focus and consumed the
  // keydown before the renderer DOM could see it.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await desktopListen<FindShortcutPayload>("browser-find-shortcut", (event) => {
        if (payloadKey(event.payload) !== keyRef.current) return;
        setIsOpen(true);
        focusInput();
      });
    })();
    return () => unlisten?.();
  }, [focusInput, payloadKey]);

  // ---- Auto-close on navigation ----
  // The find bar resets when the underlying page changes; matches from
  // the old document would be meaningless on the new one anyway.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await desktopListen<UrlChangedPayload>("browser-url-changed", (event) => {
        if (payloadKey(event.payload) !== keyRef.current) return;
        // Only react to a fresh load (loading=true) — the trailing
        // loading=false event would otherwise close the bar
        // immediately after the user opens it on a finished page.
        if (event.payload.loading) {
          close();
        }
      });
    })();
    return () => unlisten?.();
  }, [close, payloadKey]);

  const findNext = useCallback(() => {
    if (!query) return;
    void issueFind(query, { findNext: true, forward: true });
  }, [query, issueFind]);

  const findPrevious = useCallback(() => {
    if (!query) return;
    void issueFind(query, { findNext: true, forward: false });
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
