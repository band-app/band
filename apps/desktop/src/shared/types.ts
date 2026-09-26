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
 *     renderer sends (`{ appName }`, `{ browserId }`).
 *
 *   - **Event payloads** are snake_case. Tauri serialises Rust structs
 *     with snake_case fields (`browser_id`), and the
 *     existing renderer code destructures those names — so we keep that
 *     wire format on the Electron side too.
 */

// ---------- browser panes (camelCase invoke args) ----------
//
// Browser tabs are `<webview>` guests the renderer mounts itself, so
// navigation, find-in-page and zoom run on the element in the renderer.
// The main process only keeps what a renderer cannot do: map a Band tab id
// to its guest (CDP target, DevTools docking), host ensure-only tabs for the
// CDP bridge, and enforce the guest policy (`browser/guest-policy.ts`).

export interface BrowserKeyArg {
  browserId: string;
}

/**
 * Tie a `<webview>` guest to its Band tab id. Sent by the pane on the
 * webview's `did-attach`, and again whenever the guest is replaced (a
 * reparented webview gets a fresh WebContents).
 */
export interface BrowserRegisterGuestArgs extends BrowserKeyArg {
  webContentsId: number;
}

/**
 * Reply to `browser_register_guest`. `adoptUrl` is set when an ensure-only
 * offscreen page existed for this tab (the CDP bridge created it before any
 * pane mounted); the pane navigates there so an agent's navigation is not
 * lost when the user opens the tab.
 */
export interface BrowserRegisterGuestResult {
  ok: boolean;
  adoptUrl: string | null;
}

/**
 * Create-or-return-existing without a pane. Used by the CDP screencast
 * bridge so the web/agent can drive a tab whose pane hasn't mounted.
 */
export interface BrowserEnsureArgs extends BrowserKeyArg {
  url: string;
}

/**
 * Dock a tab's DevTools into a second `<webview>` the pane mounted below
 * the page (`devToolsWebContentsId` is that webview's guest).
 */
export interface BrowserOpenDevToolsArgs extends BrowserKeyArg {
  devToolsWebContentsId: number;
}

/**
 * Emitted when the user accepts a TLS exception in the in-view
 * cert interstitial (issue #444). The host is what the dashboard
 * chrome keys its "Not Secure" badge off of — `host` is already
 * lowercased and port-stripped by the desktop side.
 */
export interface BrowserHostOverriddenPayload {
  host: string;
}

// ---------- browser panes (snake_case event payloads) ----------

export interface BrowserUrlChangedPayload {
  url: string;
  browser_id: string;
  loading: boolean;
}

export interface BrowserTitleChangedPayload {
  browser_id: string;
  title: string;
}

/**
 * Emitted when a tab's page WebContents goes away: its `<webview>` was
 * removed or replaced, or an ensure-only offscreen page was closed or
 * adopted by a pane. `BrowserHostBridge` forwards it to the
 * `browserHost.viewDestroyed` mutation so the server clears its
 * bandTabId → cdpTargetId cache.
 */
export interface BrowserViewDestroyedPayload {
  browser_id: string;
}

/**
 * A pane-level shortcut pressed while keyboard focus is inside a guest page.
 * The guest consumes its own keydowns, so the renderer never sees them; the
 * main process swallows the key and forwards it, and the renderer re-dispatches
 * it as a `keydown` on the tab's `<webview>` so the ordinary DOM handlers
 * (find bar, new tab, close, split, cycle) run as if focus were in Band's UI.
 */
export interface BrowserGuestShortcutPayload {
  browser_id: string;
  key: string;
  code: string;
  shift: boolean;
  control: boolean;
  meta: boolean;
}

/**
 * Emitted when a page inside a tab requests a new window
 * (`window.open(...)`, `target="_blank"`, middle / Cmd+click on a link,
 * etc — issue #488). The native OS window is always denied; the renderer
 * turns this event into a new Band browser tab next to the source tab.
 *
 * `disposition` is the raw Chromium hint about how the page asked
 * the window to be opened, passed through unchanged. The union mirrors
 * the one Electron's `webContents.setWindowOpenHandler` callback emits.
 */
export interface BrowserOpenWindowPayload {
  browser_id: string;
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
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

/**
 * Open the system "Save As" picker and persist `content` to the chosen
 * path. `defaultName` seeds the filename field (e.g. "Untitled-1.txt");
 * `defaultPath` seeds the directory (e.g. the active workspace root).
 *
 * Backs the editor's "Save untitled tab" flow — see `pickSaveFile` in
 * `apps/desktop/src/main/ipc/macos-shell.ts`. The renderer never writes
 * to disk directly: bundling the dialog + write into one IPC call keeps
 * the file-system trust boundary inside the desktop shell.
 *
 * **Size limit:** `content` is capped at 100 MB UTF-8 bytes (see
 * `SAVE_CONTENT_MAX_BYTES` in `macos-shell.ts`). Exceeding this rejects
 * before the dialog appears so the renderer surfaces a clear error
 * rather than stalling the main-process event loop on a huge write.
 */
export interface PickSaveFileArgs {
  content: string;
  defaultName?: string;
  defaultPath?: string;
}
