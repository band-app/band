/**
 * Single source of truth for IPC channel and event names. Both the Electron
 * main process and the renderer (via the preload bridge) reference these.
 *
 * Channel names match the Tauri command names (snake_case) so the React
 * frontend's call sites can be drop-in replaced with the bridge in
 * `apps/web/src/lib/desktop-ipc.ts`. See plan in /Users/amirilovic/.claude/plans
 * and the original Tauri handler list in
 * `apps/dashboard/src-tauri/src/lib.rs`.
 */

export const Channels = {
  // Phase 1 — web server lifecycle + window
  webserverStart: "webserver_start",
  webserverStop: "webserver_stop",
  getAppTitle: "get_app_title",
  windowStartDragging: "window_start_dragging",

  // Phase 2 — macOS shell bridges + open_external
  pickFolder: "pick_folder",
  revealInFinder: "reveal_in_finder",
  checkAppExists: "check_app_exists",
  openWithApp: "open_with_app",
  installCli: "install_cli",
  openExternal: "open_external",

  // Phase 3 — browser panels
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
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

export const Events = {
  browserUrlChanged: "browser-url-changed",
  browserTitleChanged: "browser-title-changed",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

/** Allowlist used by the preload to gate which channels it forwards. */
export const ALLOWED_INVOKE_CHANNELS = new Set<string>(Object.values(Channels));

export const ALLOWED_EVENT_NAMES = new Set<string>(Object.values(Events));
