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

  // Background app-update banner (see updater.ts)
  updaterStatus: "updater_status",
  updaterInstall: "updater_install",

  // Browser panels
  browserCreate: "browser_create",
  browserNavigate: "browser_navigate",
  browserGoBack: "browser_go_back",
  browserGoForward: "browser_go_forward",
  browserEval: "browser_eval",
  browserReload: "browser_reload",
  browserSetBounds: "browser_set_bounds",
  browserHide: "browser_hide",
  browserShow: "browser_show",
  browserDestroy: "browser_destroy",
  browserHideAllForWorkspace: "browser_hide_all_for_workspace",
  browserShowAllForWorkspace: "browser_show_all_for_workspace",
  // CDP screencast experiment: bridge for the web/agent to materialise
  // a Band browser tab as a real WebContentsView and read its
  // chromium-side targetId.
  browserEnsure: "browser_ensure",
  browserGetCdpTarget: "browser_get_cdp_target",
  // Find-in-page (Cmd+F / Ctrl+F overlay on a browser tab). The main
  // process calls Electron's native `webContents.findInPage` so matches
  // are highlighted by Chromium itself; results stream back as
  // `browser-found-in-page` events.
  browserFindInPage: "browser_find_in_page",
  browserStopFindInPage: "browser_stop_find_in_page",
  // Snapshot the current rendered frame as a JPEG data URL. Used by
  // the renderer-side "freeze-on-overlay" mechanism so popovers /
  // dialogs / dropdowns stack visibly over a static raster instead of
  // disappearing behind the native WebContentsView's OS compositor
  // layer. See `BrowserViewManager.capturePage`.
  browserCapturePage: "browser_capture_page",
  // Pause / resume media playback alongside the freeze. `setVisible`
  // alone doesn't stop audio; these IPCs add `setAudioMuted` plus a
  // top-frame `pause()` / `play()` sweep so an open overlay matches
  // the user's intuition that the page is "really" paused while the
  // popup is up. See `BrowserViewManager.pauseMedia` / `resumeMedia`.
  browserPauseMedia: "browser_pause_media",
  browserResumeMedia: "browser_resume_media",
  // Per-tab zoom (Cmd+= / Cmd+- / Actual Size). Adjusts
  // `webContents.zoomFactor` on the matching view — independent of the
  // dashboard's `document.documentElement.style.zoom` and from other
  // tabs.
  browserZoom: "browser_zoom",
  // Toggle Chromium DevTools for the matching view. DevTools is docked
  // inside the tab area (bottom split) via a sibling `WebContentsView`
  // wired up with `setDevToolsWebContents` — not as a detached OS
  // window.
  browserToggleDevTools: "browser_toggle_dev_tools",
  // Chrome-style error pages for cert / load failures are rendered
  // INSIDE the WebContentsView via a `data:` URI (issue #444 — see
  // `browser/error-html.ts`). The user's button clicks become
  // `band-action://…` navigations which the per-tab `will-navigate`
  // interceptor in `view-manager.ts` translates into the matching
  // manager call — no renderer-side IPC needed for the buttons
  // themselves. The only renderer-facing surface is the
  // `browser-host-overridden` event below, so the dashboard chrome
  // can paint the "Not Secure" badge.
  //
  // Renderer-mounted-late catch-up: report which hosts already have
  // an active session exception so the badge shows up correctly
  // when a panel is restored after the user already proceeded.
  browserGetOverriddenHosts: "browser_get_overridden_hosts",
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
  /** Emitted when a `WebContentsView` is destroyed (LRU eviction,
   *  explicit close, or `destroyAll` on app quit). The renderer uses
   *  this to invalidate the server's bandTabId → cdpTargetId cache via
   *  the `browserHost.viewDestroyed` tRPC mutation. */
  browserViewDestroyed: "browser-view-destroyed",
  /** Streamed for every `webContents.findInPage` request (one initial
   *  result + zero or more updates ending with `final_update: true`).
   *  Drives the match counter (`3 of 12`) in the renderer find bar. */
  browserFoundInPage: "browser-found-in-page",
  /** Pushed when the user presses Cmd+F / Ctrl+F while keyboard focus is
   *  inside the WebContentsView. The renderer's DOM-level keydown
   *  listener never sees those events (Chromium consumes them inside the
   *  child view) so the main process intercepts them via
   *  `before-input-event` and forwards them back as this event for the
   *  React find bar to open. */
  browserFindShortcut: "browser-find-shortcut",
  /** Pushed when the user presses Cmd+T / Ctrl+T while focus is inside a
   *  WebContentsView. The renderer's DockviewBrowserContainer reacts by
   *  opening a new tab in whichever container holds the source pane. */
  browserNewTabShortcut: "browser-new-tab-shortcut",
  /** Pushed when the user presses Cmd+D / Cmd+Shift+D while focus is
   *  inside a WebContentsView. The payload's `direction` ("right" or
   *  "below") tells the renderer which split orientation to apply. */
  browserSplitShortcut: "browser-split-shortcut",
  /** Pushed when the user presses Cmd+W while focus is inside a
   *  WebContentsView. The renderer closes the source tab via the same
   *  path as the close-button click. */
  browserCloseShortcut: "browser-close-shortcut",
  /** Pushed when the user presses Cmd+[ / Cmd+] / Cmd+Shift+[ / Cmd+Shift+]
   *  / Ctrl+(Shift)+Tab while focus is inside a WebContentsView.
   *  The payload's `target` is "tabs" (cycle inside the current group)
   *  or "groups" (cycle between split groups); `direction` is +1 or -1. */
  browserCycleShortcut: "browser-cycle-shortcut",
  /** Pushed when the user accepts a TLS exception (clicks Proceed
   *  in the in-view cert interstitial). Carries the host so the
   *  renderer can flag the address bar with a "Not Secure" badge
   *  for that origin. The cert interstitial itself is rendered
   *  inside the WebContentsView (see `browser/error-html.ts`) so
   *  it stays visible during screencast — this event is only for
   *  the surrounding dashboard chrome. */
  browserHostOverridden: "browser-host-overridden",
  /** Pushed when a page inside a `WebContentsView` requests a new
   *  window — `window.open(...)`, `target="_blank"`, middle / Cmd+
   *  click on a link, etc. The main process *always* denies the
   *  native OS window (so no detached browser window ever appears)
   *  and forwards the request here so the renderer can materialize
   *  the request as a new Band browser tab in the same workspace
   *  (issue #488). The renderer's `DockviewBrowserContainer` picks
   *  up the event and calls its existing add-tab flow scoped to the
   *  source pane's dockview group; events whose `browser_id` isn't
   *  in this container are ignored, so multiple workspaces don't all
   *  spawn tabs for one window.open. */
  browserOpenWindow: "browser-open-window",
  windowFullscreenChanged: "window-fullscreen-changed",
  /** Pushed by the main process when the background updater detects (or
   *  clears) a pending app update. Payload: `PendingUpdate` from
   *  updater.ts — `null` or `{ version }`. */
  updaterStatusChanged: "updater-status-changed",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

/** Allowlist used by the preload to gate which channels it forwards. */
export const ALLOWED_INVOKE_CHANNELS = new Set<string>(Object.values(Channels));

export const ALLOWED_EVENT_NAMES = new Set<string>(Object.values(Events));
