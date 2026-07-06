import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  SearchBar,
  type SearchBarHandle,
  type TerminalInsertDetail,
  useSettingsQuery,
} from "@/dashboard";
import { useVirtualKeyboardToolbar } from "../hooks/useVirtualKeyboardToolbar";
import {
  getOrCreateTerminal,
  type PaneMetadata,
  type TerminalCacheEntry,
} from "../lib/terminal-cache";
import { TerminalToolbar } from "./TerminalToolbar";

export type { PaneMetadata };

interface TerminalPanelProps {
  workspaceId: string;
  terminalId: string;
  visible: boolean;
  /** Optional metadata from workspace terminal config (command, cwd, env). */
  paneMetadata?: PaneMetadata;
  /** When true, auto-focus this terminal after it opens. */
  autoFocus?: boolean;
  /** Called when the terminal emits a title change (shell window title). */
  onTitleChange?: (title: string) => void;
}

/**
 * Thin React view over a cached, persistent xterm instance.
 *
 * The xterm lifecycle (creation, addons, WebSocket, reconnect, resize/zoom/DPR,
 * gestures, and the search/selection/sticky-Ctrl UI state) lives entirely in
 * `terminal-cache.ts`. This component only:
 *   - resolves (or lazily creates) the cache entry for `terminalId`,
 *   - `attach`es the entry's persistent wrapper into a live container when the
 *     panel is visible and `detach`es (parks it off-screen) otherwise — never
 *     disposing on a workspace/tab switch (band-app/band#617),
 *   - mirrors the entry's reactive UI state via `useSyncExternalStore` and
 *     renders the find bar + iOS keyboard toolbar wired to the entry's handlers.
 *
 * Dispose is driven externally (pane close / workspace eviction), NOT by this
 * component's unmount — unmount only parks.
 */
export function TerminalPanel({
  workspaceId,
  terminalId,
  visible,
  paneMetadata,
  autoFocus,
  onTitleChange,
}: TerminalPanelProps) {
  const liveRef = useRef<HTMLDivElement>(null);
  const searchBarRef = useRef<SearchBarHandle>(null);

  // WebGL preference is snapshotted at entry-create time; toggling it later
  // should not tear down a live session (users are told to reopen the terminal).
  const { settings } = useSettingsQuery();
  const useWebGL = settings.useWebGLTerminalRenderer ?? true;

  // Resolve (or create) the stable cache entry for this terminal. Kept in a ref
  // so `subscribe`/`getSnapshot` identities stay stable across renders; only a
  // terminalId change (never happens for a given dockview panel) re-resolves.
  const entryRef = useRef<TerminalCacheEntry | null>(null);
  // Re-resolve when the terminalId changes (never for a given panel) OR when the
  // held entry was disposed out from under us — the cache's LRU can evict a
  // parked entry while this panel is mounted-but-hidden (a cached, inactive
  // workspace). On becoming visible again we must pick up a fresh entry, which
  // reconnects + replays, rather than attach a destroyed one (a no-op that would
  // leave a dead/blank terminal).
  if (
    !entryRef.current ||
    entryRef.current.terminalId !== terminalId ||
    entryRef.current.isDestroyed()
  ) {
    entryRef.current = getOrCreateTerminal(terminalId, {
      workspaceId,
      paneMetadata,
      useWebGL,
      autoFocus,
    });
  }
  const entry = entryRef.current;

  const state = useSyncExternalStore(entry.subscribe, entry.getSnapshot);

  // Attach when visible, park when hidden. Park (not dispose) on unmount.
  useEffect(() => {
    const el = liveRef.current;
    if (!el) return;
    if (visible) entry.attach(el, { autoFocus });
    else entry.detach();
  }, [visible, entry, autoFocus]);
  useEffect(() => () => entry.detach(), [entry]);

  // Route title changes to the dockview tab; replays the last known title so a
  // title set while this panel was unmounted/parked isn't lost.
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  useEffect(
    () => entry.registerTitleListener((title) => onTitleChangeRef.current?.(title)),
    [entry],
  );

  // Workspace-level ⌃` "focus Terminal": only the visible session grabs focus.
  useEffect(() => {
    const handler = () => {
      if (visible) entry.focus();
    };
    window.addEventListener("band:focus-terminal", handler);
    return () => window.removeEventListener("band:focus-terminal", handler);
  }, [visible, entry]);

  // ---- Find-in-terminal: focus + select the bar when it opens ----
  useEffect(() => {
    if (!state.searchOpen) return;
    const id = requestAnimationFrame(() => {
      searchBarRef.current?.focus();
      searchBarRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [state.searchOpen]);

  // ---- "Add to Terminal" reference delivery (mirrors the old buffering) ----
  // A reference dispatched via `band:terminal-insert` is written verbatim to the
  // PTY as typed input (no newline). Surfacing the terminal flips `visible` on a
  // later render, so buffer until this panel is visible with an open socket;
  // drop the buffer when hidden so a stale reference can't surface later.
  const pendingInsertRef = useRef<string | null>(null);
  const flushPendingInsert = useCallback(() => {
    const reference = pendingInsertRef.current;
    if (!reference) return;
    if (!entry.isSocketOpen()) return;
    entry.sendInput(reference);
    pendingInsertRef.current = null;
    entry.focus();
  }, [entry]);

  useEffect(() => {
    if (visible) flushPendingInsert();
    else pendingInsertRef.current = null;
  }, [visible, flushPendingInsert]);

  // Flush a reference buffered during a reconnect gap once the socket reopens.
  useEffect(
    () =>
      entry.subscribeConnect(() => {
        if (visible) flushPendingInsert();
      }),
    [entry, visible, flushPendingInsert],
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<TerminalInsertDetail>).detail;
      if (!detail?.reference || detail.workspaceId !== workspaceId) return;
      if (detail.terminalId && detail.terminalId !== terminalId) return;
      pendingInsertRef.current = detail.reference;
      if (visible) flushPendingInsert();
    };
    window.addEventListener("band:terminal-insert", handler);
    return () => window.removeEventListener("band:terminal-insert", handler);
  }, [visible, workspaceId, terminalId, flushPendingInsert]);

  // Reserve space at the bottom for the floating iOS keyboard toolbar (0 on
  // desktop). The cache's ResizeObserver on the wrapper reflows xterm on change.
  const { contentBottomInset } = useVirtualKeyboardToolbar();

  const terminal = entry.getTerminal();

  return (
    <div className="relative flex h-full w-full flex-col">
      {state.searchOpen && (
        <SearchBar
          ref={searchBarRef}
          query={state.searchQuery}
          onQueryChange={entry.setSearchQuery}
          options={state.searchOptions}
          onOptionsChange={entry.setSearchOptions}
          placeholder="Find in terminal..."
          matchInfo={state.matchInfo}
          onNext={entry.findNext}
          onPrevious={entry.findPrevious}
          onClose={entry.closeSearch}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {/* Sizing box only — the cache's persistent wrapper (which carries the
            counter-zoom and hosts xterm) is appended here on `attach` and moved
            to the parking container on `detach`. `absolute` makes it the
            positioned containing block for the wrapper's `inset: 0`. */}
        <div
          ref={liveRef}
          className="absolute inset-x-2 top-2 overflow-hidden"
          style={{ bottom: 8 + contentBottomInset }}
        />
      </div>
      {state.ready && terminal && (
        <TerminalToolbar
          terminal={terminal}
          sendInput={entry.sendInput}
          pendingCtrl={state.pendingCtrl}
          onToggleCtrl={entry.toggleCtrl}
          selectionMode={state.selectionMode}
          onExtendSelection={entry.extendSelection}
          onExitSelection={entry.exitSelection}
          onSelectAll={entry.selectAll}
        />
      )}
    </div>
  );
}
