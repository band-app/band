/**
 * Browser tab lifecycle management.
 *
 * Each browser tab maps to a webview instance (native on desktop, iframe on web).
 * Modeled on chat-manager.ts — in-memory registry backed by the
 * generic `panel_states` table for persistence across server restarts.
 */

import { createLogger } from "@band-app/logger";
import {
  deletePanelState,
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStates,
  updatePanelState,
} from "./panel-state-store";

const log = createLogger("browser-manager");

const PANEL_TYPE = "browser";

export type BrowserStatus = "idle" | "loading" | "error";

export interface BrowserTab {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  status: BrowserStatus;
}

/** Shape of the JSON blob stored in `panel_states.state` for browser panels. */
interface BrowserPanelState {
  name: string;
  url: string;
  status: BrowserStatus;
}

// ---------------------------------------------------------------------------
// In-memory indices
// ---------------------------------------------------------------------------

/** Primary index: browserId -> BrowserTab */
const browserTabs = new Map<string, BrowserTab>();

/** Reverse index: workspaceId -> Set<browserId> */
const workspaceBrowsers = new Map<string, Set<string>>();

/**
 * Lazy initialization flag.  In dev mode (vite dev) the module may be loaded
 * without an explicit `loadBrowsersFromDb()` call from start-server.ts.  The
 * first public read ensures the DB is hydrated so callers always see
 * persisted browser records.
 */
let _initialized = false;

function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;
  loadBrowsersFromDb();
}

function addToIndex(tab: BrowserTab): void {
  browserTabs.set(tab.id, tab);
  let ids = workspaceBrowsers.get(tab.workspaceId);
  if (!ids) {
    ids = new Set();
    workspaceBrowsers.set(tab.workspaceId, ids);
  }
  ids.add(tab.id);
}

function removeFromIndex(browserId: string): void {
  const tab = browserTabs.get(browserId);
  if (!tab) return;
  browserTabs.delete(browserId);
  const ids = workspaceBrowsers.get(tab.workspaceId);
  if (ids) {
    ids.delete(browserId);
    if (ids.size === 0) {
      workspaceBrowsers.delete(tab.workspaceId);
    }
  }
}

function serializeState(tab: BrowserTab): string {
  const blob: BrowserPanelState = {
    name: tab.name,
    url: tab.url,
    status: tab.status,
  };
  return JSON.stringify(blob);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateBrowserOptions {
  /** Explicit ID — use when the client already generated one. */
  id?: string;
  name?: string;
  url?: string;
}

/**
 * Create a new browser tab for a workspace.
 * Persists to panel_states table and adds to in-memory registry.
 */
export function createBrowser(workspaceId: string, options?: CreateBrowserOptions): BrowserTab {
  const now = Date.now();

  const tab: BrowserTab = {
    id: options?.id ?? `browser_${crypto.randomUUID()}`,
    workspaceId,
    name: options?.name ?? "Browser",
    url: options?.url ?? "",
    status: "idle",
  };

  insertPanelState({
    id: tab.id,
    workspaceId: tab.workspaceId,
    panelType: PANEL_TYPE,
    state: serializeState(tab),
    createdAt: now,
    updatedAt: now,
  });

  addToIndex(tab);
  log.info({ browserId: tab.id, workspaceId, url: tab.url }, "browser tab created");
  return tab;
}

/**
 * Get a browser tab by ID.
 */
export function getBrowser(browserId: string): BrowserTab | undefined {
  ensureInitialized();
  return browserTabs.get(browserId);
}

/**
 * List all browser tabs for a workspace.
 */
export function listBrowsers(workspaceId: string): BrowserTab[] {
  ensureInitialized();
  const ids = workspaceBrowsers.get(workspaceId);
  if (!ids) return [];
  const tabs: BrowserTab[] = [];
  for (const id of ids) {
    const tab = browserTabs.get(id);
    if (tab) tabs.push(tab);
  }
  return tabs;
}

export interface UpdateBrowserOptions {
  name?: string;
  url?: string;
}

/**
 * Update a browser tab's configuration.
 */
export function updateBrowser(
  browserId: string,
  updates: UpdateBrowserOptions,
): BrowserTab | undefined {
  const tab = browserTabs.get(browserId);
  if (!tab) return undefined;

  if (updates.name !== undefined) tab.name = updates.name;
  if (updates.url !== undefined) tab.url = updates.url;

  updatePanelState(browserId, {
    state: serializeState(tab),
    updatedAt: Date.now(),
  });

  log.info({ browserId, updates }, "browser tab updated");
  return tab;
}

/**
 * Update a browser tab's current URL.
 * Called when the browser navigates (from frontend or CLI).
 */
export function updateBrowserUrl(browserId: string, url: string): void {
  const tab = browserTabs.get(browserId);
  if (!tab) return;
  tab.url = url;

  updatePanelState(browserId, {
    state: serializeState(tab),
    updatedAt: Date.now(),
  });
}

/**
 * Update a browser tab's status.
 */
export function updateBrowserStatus(browserId: string, status: BrowserStatus): void {
  const tab = browserTabs.get(browserId);
  if (!tab) return;
  tab.status = status;

  updatePanelState(browserId, {
    state: serializeState(tab),
    updatedAt: Date.now(),
  });
}

/**
 * Remove a browser tab. Removes from DB and in-memory maps.
 */
export function removeBrowser(browserId: string): boolean {
  const tab = browserTabs.get(browserId);
  if (!tab) return false;

  // Remove from DB
  deletePanelState(browserId);

  // Remove from in-memory maps
  removeFromIndex(browserId);

  log.info({ browserId, workspaceId: tab.workspaceId }, "browser tab removed");
  return true;
}

/**
 * Remove all browser tabs for a workspace.
 * Called when a workspace is deleted.
 */
export function removeWorkspaceBrowsers(workspaceId: string): void {
  const ids = workspaceBrowsers.get(workspaceId);
  if (!ids) return;

  for (const browserId of [...ids]) {
    browserTabs.delete(browserId);
  }

  // Bulk delete browser panel states from DB
  deletePanelStatesForWorkspace(workspaceId, PANEL_TYPE);

  workspaceBrowsers.delete(workspaceId);
  log.info({ workspaceId }, "all browser tabs removed for workspace");
}

/**
 * Load all browser tabs from the database into the in-memory registry.
 * Called on server startup. Resets all statuses to "idle".
 */
export function loadBrowsersFromDb(): number {
  _initialized = true;
  const rows = listPanelStates(PANEL_TYPE);
  const now = Date.now();

  for (const row of rows) {
    const parsed = JSON.parse(row.state) as BrowserPanelState;

    // Reset status to idle on startup
    parsed.status = "idle";
    updatePanelState(row.id, {
      state: JSON.stringify(parsed),
      updatedAt: now,
    });

    const tab: BrowserTab = {
      id: row.id,
      workspaceId: row.workspaceId,
      name: parsed.name,
      url: parsed.url,
      status: "idle",
    };
    addToIndex(tab);
  }

  if (rows.length > 0) {
    log.info({ count: rows.length }, "loaded browser tabs from database");
  }
  return rows.length;
}
