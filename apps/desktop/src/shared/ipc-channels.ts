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

  // macOS shell bridges + open_external
  pickFolder: "pick_folder",
  revealInFinder: "reveal_in_finder",
  checkAppExists: "check_app_exists",
  openWithApp: "open_with_app",
  installCli: "install_cli",
  openExternal: "open_external",

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
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

export const Events = {
  browserUrlChanged: "browser-url-changed",
  browserTitleChanged: "browser-title-changed",
  /** Emitted when a `WebContentsView` is destroyed (LRU eviction,
   *  explicit close, or `destroyAll` on app quit). The renderer uses
   *  this to invalidate the server's bandTabId → cdpTargetId cache via
   *  the `browserHost.viewDestroyed` tRPC mutation. */
  browserViewDestroyed: "browser-view-destroyed",
  windowFullscreenChanged: "window-fullscreen-changed",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

/** Allowlist used by the preload to gate which channels it forwards. */
export const ALLOWED_INVOKE_CHANNELS = new Set<string>(Object.values(Channels));

export const ALLOWED_EVENT_NAMES = new Set<string>(Object.values(Events));
