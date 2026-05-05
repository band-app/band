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
