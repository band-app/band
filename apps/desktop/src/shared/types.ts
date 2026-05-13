/**
 * Shared types for IPC payloads. Both the main process handlers and the
 * preload bridge reference these. The renderer side (in `apps/web`) does
 * not import this file directly — it relies on the dynamic invoke/listen
 * surface of `apps/web/src/lib/desktop-ipc.ts`.
 *
 * Conventions:
 *
 *   - **Invoke args** are camelCase. Tauri auto-converts the renderer's
 *     camelCase invoke payloads to Rust's snake_case at the FFI boundary;
 *     Electron has no such layer, so we accept the raw camelCase the
 *     renderer sends (`{ appName }`, `{ browserId }`, `{ workspaceId }`).
 *
 *   - **Event payloads** are snake_case. Tauri serialises Rust structs
 *     with snake_case fields (`browser_id`, `workspace_id`), and the
 *     existing renderer code destructures those names — so we keep that
 *     wire format on the Electron side too.
 *
 *   - The browser commands accept EITHER `browserId` (multi-tab mode in
 *     `BrowserPaneComponent`) OR `workspaceId` (legacy single-panel mode
 *     in `BrowserPanelComponent`). The handler picks whichever is present
 *     and uses it as the LRU key. The `*ForWorkspace` bulk commands
 *     ignore the id entirely.
 */

// ---------- browser panels (camelCase invoke args) ----------

/** Either id may be sent by the renderer; we use whichever is present. */
export interface BrowserKeyArg {
  browserId?: string;
  workspaceId?: string;
}

export interface BrowserCreateArgs extends BrowserKeyArg {
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}

export interface BrowserNavigateArgs extends BrowserKeyArg {
  url: string;
}

export interface BrowserBoundsArgs extends BrowserKeyArg {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserEvalArgs extends BrowserKeyArg {
  js: string;
}

/**
 * Create-or-return-existing without bounds. Used by the CDP screencast
 * bridge so the web/agent can ask the desktop to materialise a tab whose
 * dockview panel hasn't mounted yet.
 */
export interface BrowserEnsureArgs extends BrowserKeyArg {
  url: string;
}

/**
 * Forwarded verbatim to Electron's `webContents.findInPage(text, options)`.
 *
 *   - **First search** for a given query: omit `findNext` (or set false).
 *     Chromium runs the full match scan and emits a `found-in-page` event
 *     with `matches` set to the total count.
 *   - **Step to next/previous match**: set `findNext: true` and toggle
 *     `forward` to control direction. Chromium reuses the cached result
 *     set instead of rescanning, so the counter stays in sync.
 *
 * `matchCase` is the only option Chromium reliably honours today —
 * `wordStart` / `medialCapitalAsWordStart` are accepted for forward
 * compatibility but have no visible effect, and `regex` is not supported
 * at all. Callers should hide UI toggles for unsupported options
 * (`SearchBar`'s `visibleOptions` prop) rather than silently surface a
 * no-op control.
 */
export interface BrowserFindInPageArgs extends BrowserKeyArg {
  text: string;
  options?: {
    forward?: boolean;
    findNext?: boolean;
    matchCase?: boolean;
    wordStart?: boolean;
    medialCapitalAsWordStart?: boolean;
  };
}

/**
 * Stop an active `findInPage` session. `action` controls what happens to
 * the page selection — defaults to `clearSelection` which removes both
 * the highlight and the selection so closing the find bar leaves the
 * page visually undisturbed.
 */
export interface BrowserStopFindInPageArgs extends BrowserKeyArg {
  action?: "clearSelection" | "keepSelection" | "activateSelection";
}

/**
 * Per-tab zoom adjustment.
 *
 *   - `"in"` / `"out"` step the existing `webContents.zoomFactor` by a
 *     fixed amount (currently 0.1, matching the dashboard's zoom step).
 *   - `"reset"` sets it back to 1.0 (100%).
 *
 * Clamped to [0.5, 2.0] to mirror the dashboard's range.
 */
export interface BrowserZoomArgs extends BrowserKeyArg {
  action: "in" | "out" | "reset";
}

/** Resolve the LRU key from whichever id the renderer included. */
export function browserKey(args: BrowserKeyArg): string {
  return args.browserId ?? args.workspaceId ?? "";
}

// ---------- browser panels (snake_case event payloads) ----------

export interface BrowserUrlChangedPayload {
  url: string;
  browser_id: string;
  workspace_id: string;
  loading: boolean;
}

export interface BrowserTitleChangedPayload {
  browser_id: string;
  workspace_id: string;
  title: string;
}

/**
 * Emitted by `BrowserViewManager.destroy()` (LRU eviction, explicit
 * close, app quit). The renderer translates this into a
 * `browserHost.viewDestroyed` tRPC mutation so the server can clear its
 * bandTabId → cdpTargetId cache.
 */
export interface BrowserViewDestroyedPayload {
  browser_id: string;
  workspace_id: string;
}

/**
 * One result tick from a `webContents.findInPage` request. Chromium
 * emits at least one event per request and may stream incremental
 * updates as it scans large pages — `final_update` flips to `true` on
 * the last event for the request, at which point `matches` is the
 * authoritative total. `active_match_ordinal` is 1-indexed (or 0 when
 * the query is empty / no match is selected).
 */
export interface BrowserFoundInPagePayload {
  browser_id: string;
  workspace_id: string;
  request_id: number;
  active_match_ordinal: number;
  matches: number;
  final_update: boolean;
}

/**
 * Emitted when the user presses the find-in-page shortcut (Cmd+F on
 * macOS, Ctrl+F elsewhere) while keyboard focus is *inside* the
 * `WebContentsView` — i.e. the React DOM cannot see the keydown. The
 * renderer reacts the same way it does to its own keydown handler:
 * opens the find bar for the matching tab.
 */
export interface BrowserFindShortcutPayload {
  browser_id: string;
  workspace_id: string;
}

/**
 * Emitted when the user presses Cmd+T / Ctrl+T while keyboard focus is
 * inside a `WebContentsView`. Carries the source tab's key so the
 * renderer can locate the right `DockviewBrowserContainer` and add a
 * new sibling tab into it.
 */
export interface BrowserNewTabShortcutPayload {
  browser_id: string;
  workspace_id: string;
}

// ---------- macOS shell (camelCase invoke args) ----------

export interface CheckAppExistsArgs {
  appName: string;
}

export interface RevealInFinderArgs {
  path: string;
}

export interface OpenWithAppArgs {
  path: string;
  appName: string;
}

export interface InstallCliArgs {
  binaryPath: string;
  symlinkPath: string;
}

export interface OpenExternalArgs {
  url: string;
}
