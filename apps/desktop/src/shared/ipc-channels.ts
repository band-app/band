/**
 * Single source of truth for IPC channel and event names. Both the Electron
 * main process and the renderer (via the preload bridge) reference these.
 *
 * Channels use snake_case so the renderer's call shapes match what the IPC
 * layer registers. Native window dragging is wired via CSS
 * `-webkit-app-region: drag` on the title bar — no IPC channel needed.
 */

export const Channels = {
  // Web server lifecycle + window
  webserverStart: "webserver_start",
  webserverStop: "webserver_stop",
  getAppTitle: "get_app_title",
  getWindowFullscreen: "get_window_fullscreen",
  // Per-process Electron/Chromium resource metrics (app.getAppMetrics()).
  // Surfaced on the Resources page's "Desktop app (Electron)" card.
  getAppMetrics: "get_app_metrics",

  // macOS shell bridges + open_external
  pickFolder: "pick_folder",
  pickFile: "pick_file",
  pickSaveFile: "pick_save_file",
  revealInFinder: "reveal_in_finder",
  checkAppExists: "check_app_exists",
  openWithApp: "open_with_app",
  installCli: "install_cli",
  openExternal: "open_external",

  // App-update toast (see updater.ts)
  updaterStatus: "updater_status",
  updaterCheck: "updater_check",
  updaterDownload: "updater_download",
  updaterRestart: "updater_restart",
  updaterDismiss: "updater_dismiss",

  // Browser panes. Tabs are `<webview>` guests the renderer drives
  // directly (navigation, find, zoom); these cover what only main can do.
  // Tie a guest to its Band tab id (CDP target lookup, DevTools docking,
  // keyed events). See `BrowserGuestManager.registerGuest`.
  browserRegisterGuest: "browser_register_guest",
  // CDP screencast experiment: bridge for the web/agent to materialise
  // a Band browser tab (an offscreen page when no pane is mounted) and
  // read its chromium-side targetId.
  browserEnsure: "browser_ensure",
  browserGetCdpTarget: "browser_get_cdp_target",
  // Dock a tab's DevTools into the pane's second `<webview>` via
  // `setDevToolsWebContents`, and close them again.
  browserOpenDevTools: "browser_open_dev_tools",
  browserCloseDevTools: "browser_close_dev_tools",
  // Chrome-style error pages for cert / load failures are rendered
  // INSIDE the guest via a `data:` URI (issue #444, see
  // `browser/error-html.ts`). The user's button clicks become
  // `band-action://…` navigations which the guest manager translates
  // into the matching action, so the buttons need no renderer IPC. The
  // only renderer-facing surface is the `browser-host-overridden`
  // event below, so the dashboard chrome can paint the "Not Secure"
  // badge.
  //
  // Renderer-mounted-late catch-up: report which hosts already have
  // an active session exception so the badge shows up correctly
  // when a pane is restored after the user already proceeded.
  browserGetOverriddenHosts: "browser_get_overridden_hosts",
  // Browser profiles: list the user's Chrome profiles, import one's
  // cookies into a Band profile's session partition, wipe a deleted
  // profile's partition, and wipe partitions the server no longer knows.
  // The renderer asks the user before the first two; cookie values never
  // cross IPC (only counts come back).
  browserChromeProfiles: "browser_chrome_profiles",
  browserChromeImport: "browser_chrome_import",
  browserProfileClearData: "browser_profile_clear_data",
  browserProfilePrune: "browser_profile_prune",
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

export const Events = {
  /** Pushed when the machine wakes from system sleep or the screen is
   *  unlocked (powerMonitor `resume` / `unlock-screen`). The window often
   *  kept OS focus through the nap, so the renderer sees neither `focus`
   *  nor `visibilitychange` — but the GPU may have discarded texture
   *  memory in the meantime. WebGL surfaces (terminal glyph atlases)
   *  subscribe to repair themselves. */
  systemResumed: "system-resumed",
  browserUrlChanged: "browser-url-changed",
  browserTitleChanged: "browser-title-changed",
  /** Emitted when a tab's page WebContents goes away (its `<webview>` was
   *  removed or replaced, or an ensure-only offscreen page closed). The
   *  renderer uses this to invalidate the server's bandTabId →
   *  cdpTargetId cache via the `browserHost.viewDestroyed` tRPC mutation. */
  browserViewDestroyed: "browser-view-destroyed",
  /** Pushed when the user presses a pane shortcut (Cmd/Ctrl+F, T, W, D,
   *  [ and ], Ctrl+Tab) while keyboard focus is inside a guest page. The
   *  guest consumes its own keydowns, so the main process intercepts them
   *  via `before-input-event` and the renderer re-dispatches them on the
   *  tab's `<webview>`. */
  browserGuestShortcut: "browser-guest-shortcut",
  /** Pushed when the user accepts a TLS exception (clicks Proceed
   *  in the in-view cert interstitial). Carries the host so the
   *  renderer can flag the address bar with a "Not Secure" badge
   *  for that origin. The cert interstitial itself is rendered
   *  inside the guest (see `browser/error-html.ts`) so it stays
   *  visible during screencast; this event is only for the
   *  surrounding dashboard chrome. */
  browserHostOverridden: "browser-host-overridden",
  /** Pushed when a page inside a tab requests a new window:
   *  `window.open(...)`, `target="_blank"`, middle / Cmd+click on a
   *  link, etc. The main process always denies the native OS window
   *  (so no detached browser window ever appears) and forwards the
   *  request here so the renderer can open it as a new Band browser
   *  tab next to the source tab (issue #488). */
  browserOpenWindow: "browser-open-window",
  windowFullscreenChanged: "window-fullscreen-changed",
  /** Pushed by the main process on every auto-update status change.
   *  Payload: `UpdateStatus` from shared/update-status.ts. */
  updaterStatusChanged: "updater-status-changed",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

/** Allowlist used by the preload to gate which channels it forwards. */
export const ALLOWED_INVOKE_CHANNELS = new Set<string>(Object.values(Channels));

export const ALLOWED_EVENT_NAMES = new Set<string>(Object.values(Events));
