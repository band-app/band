/**
 * Business logic for browser tabs.
 *
 * Services tier — owns the in-memory `Map<browserId, BrowserTab>` registry
 * and layout integration. Depends on Infra (`BrowserQueries`) only; knows
 * nothing about tRPC. The API tier (`server/api/browsers/router.ts`) is a
 * thin pass-through.
 *
 * Created in issue #316 (Phase 5 of the 3-tier refactor) by lifting the
 * business half of `lib/browser-manager.ts` + `lib/browser-layout-manager.ts`
 * out of `lib/` and into this class. `lib/browser-layout-manager.ts` has
 * been deleted entirely now that its only caller (`workspace-service`)
 * goes through `browserService.removeAllForWorkspace` — which is self-
 * contained per the contract below. `lib/browser-manager.ts` remains as
 * a back-compat shim because it still has live importers (`start-server`,
 * `workspace-service`); subsequent phases will rewrite those call sites
 * to import from this module directly.
 */

import { createLogger } from "@band-app/logger";
import { DockviewLayoutManager } from "../../lib/dockview-layout-manager";
import {
  BrowserQueries,
  type BrowserRow,
  type BrowserStatus,
  type BrowserUpdatePatch,
} from "../infra/db/queries/browsers";

const log = createLogger("browser-service");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { BrowserStatus };

/**
 * Public browser-tab shape — what `browsers.list` / `browsers.get` hand the
 * dashboard. Identical to `BrowserRow` (the Infra shape); aliased here so
 * callers that already import `BrowserTab` from `lib/browser-manager.ts`
 * keep compiling.
 */
export type BrowserTab = BrowserRow;

export interface CreateBrowserOptions {
  /** Explicit ID — use when the client already generated one. */
  id?: string;
  name?: string;
  url?: string;
}

export interface UpdateBrowserOptions {
  name?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// BrowserService
// ---------------------------------------------------------------------------

/**
 * Lifecycle and orchestration for browser tabs.
 *
 * The service owns:
 *   - The in-memory primary index (`browserId → BrowserTab`)
 *   - The reverse index (`workspaceId → Set<browserId>`)
 *   - Lazy hydration from `panel_states` on first read
 *   - Layout integration via `DockviewLayoutManager("browser_layout")`
 *
 * Stateful by design — there's exactly one instance (`browserService` below).
 * The `lib/browser-manager.ts` back-compat shim delegates every call here so
 * existing modules (`browser-host.ts`, the CLI adapter, …) keep working
 * without touching their imports.
 *
 * Object-identity contract: `update*` methods do NOT mutate the prior
 * `BrowserTab` in place — they store a fresh merged object in the
 * registry and discard the previous reference. Callers that hold a
 * snapshot from `get`/`list` MUST re-`get` after any mutation to see the
 * new values. (The pre-refactor `lib/browser-manager.ts` mutated in place;
 * the shim continues to expose the function-shaped API so wire callers
 * see no behaviour change as long as they re-read on each access, which
 * every current caller — `browser-host`, `start-server`, the routers —
 * already does.)
 */
export class BrowserService {
  // Primary index: browserId → BrowserTab
  private readonly browserTabs = new Map<string, BrowserTab>();
  // Reverse index: workspaceId → Set<browserId>
  private readonly workspaceBrowsers = new Map<string, Set<string>>();

  /**
   * Lazy initialization flag. In dev mode (vite dev) the service may be
   * loaded without an explicit `loadFromDb()` call from start-server.ts.
   * The first public read ensures the DB is hydrated so callers always
   * see persisted browser records.
   */
  private initialized = false;

  constructor(
    private readonly queries: BrowserQueries = new BrowserQueries(),
    private readonly layoutManager: DockviewLayoutManager = new DockviewLayoutManager(
      "browser_layout",
    ),
  ) {}

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.loadFromDb();
  }

  private addToIndex(tab: BrowserTab): void {
    this.browserTabs.set(tab.id, tab);
    let ids = this.workspaceBrowsers.get(tab.workspaceId);
    if (!ids) {
      ids = new Set();
      this.workspaceBrowsers.set(tab.workspaceId, ids);
    }
    ids.add(tab.id);
  }

  private removeFromIndex(browserId: string): void {
    const tab = this.browserTabs.get(browserId);
    if (!tab) return;
    this.browserTabs.delete(browserId);
    const ids = this.workspaceBrowsers.get(tab.workspaceId);
    if (ids) {
      ids.delete(browserId);
      if (ids.size === 0) {
        this.workspaceBrowsers.delete(tab.workspaceId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new browser tab for a workspace.
   * Persists to panel_states and adds to in-memory registry.
   */
  create(workspaceId: string, options?: CreateBrowserOptions): BrowserTab {
    const now = Date.now();

    const tab: BrowserTab = {
      id: options?.id ?? `browser_${crypto.randomUUID()}`,
      workspaceId,
      name: options?.name ?? "Browser",
      url: options?.url ?? "",
      status: "idle",
    };

    this.queries.insert({ ...tab, createdAt: now, updatedAt: now });

    this.addToIndex(tab);

    // Mirror what `chatService.create` does: register the new tab in the
    // saved dockview layout so it survives a server restart and renders
    // the moment the workspace is opened. `addPanel` is idempotent, so any
    // mutation/handler that also calls `addToLayout` after `create` (the
    // `browsers.create` tRPC mutation does, transitively) is unaffected —
    // the second call refreshes metadata and bails.
    this.addToLayout(workspaceId, tab.id, {
      title: tab.name,
      initialUrl: tab.url || undefined,
    });

    log.info({ browserId: tab.id, workspaceId, url: tab.url }, "browser tab created");
    return tab;
  }

  /** Get a browser tab by ID. */
  get(browserId: string): BrowserTab | undefined {
    this.ensureInitialized();
    return this.browserTabs.get(browserId);
  }

  /** List all browser tabs for a workspace. */
  list(workspaceId: string): BrowserTab[] {
    this.ensureInitialized();
    const ids = this.workspaceBrowsers.get(workspaceId);
    if (!ids) return [];
    const tabs: BrowserTab[] = [];
    for (const id of ids) {
      const tab = this.browserTabs.get(id);
      if (tab) tabs.push(tab);
    }
    return tabs;
  }

  /**
   * Update a browser tab's configuration.
   */
  update(browserId: string, updates: UpdateBrowserOptions): BrowserTab | undefined {
    const tab = this.browserTabs.get(browserId);
    if (!tab) return undefined;

    const patch: BrowserUpdatePatch & { updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.url !== undefined) patch.url = updates.url;

    const merged = this.queries.update(browserId, tab, patch);
    this.browserTabs.set(browserId, merged);

    log.info({ browserId, updates }, "browser tab updated");
    return merged;
  }

  /**
   * Update a browser tab's current URL.
   * Called when the browser navigates (from frontend or CLI).
   */
  updateUrl(browserId: string, url: string): void {
    const tab = this.browserTabs.get(browserId);
    if (!tab) return;
    const merged = this.queries.update(browserId, tab, {
      url,
      updatedAt: Date.now(),
    });
    this.browserTabs.set(browserId, merged);
  }

  /**
   * Update a browser tab's status.
   */
  updateStatus(browserId: string, status: BrowserStatus): void {
    const tab = this.browserTabs.get(browserId);
    if (!tab) return;
    const merged = this.queries.update(browserId, tab, {
      status,
      updatedAt: Date.now(),
    });
    this.browserTabs.set(browserId, merged);
  }

  /**
   * Remove a browser tab. Removes from DB, the saved layout, and in-memory maps.
   *
   * Mirrors `ChatService.remove`: dropping the panel from the saved dockview
   * layout is part of the service-level "remove" contract, not something the
   * API tier has to remember to do as a second step. Keeps the two pane
   * domains symmetric so callers (the tRPC router today, future direct
   * `browserService.remove` callers tomorrow) get the same one-call cleanup.
   */
  remove(browserId: string): boolean {
    const tab = this.browserTabs.get(browserId);
    if (!tab) return false;

    this.queries.remove(browserId);

    // Drop the panel from the saved dockview layout. Done before the
    // in-memory removal so the workspaceId is still available without a
    // second lookup. `removePanel` is a no-op if the panel was never
    // registered (e.g. a browser created before `create()` started auto-
    // adding to the layout), so this is safe across legacy rows.
    this.removeFromLayout(tab.workspaceId, browserId);

    this.removeFromIndex(browserId);

    log.info({ browserId, workspaceId: tab.workspaceId }, "browser tab removed");
    return true;
  }

  /**
   * Remove all browser tabs for a workspace.
   * Called when a workspace is deleted.
   *
   * Drops the saved dockview layout in the same call — mirrors `remove()`,
   * which calls `removeFromLayout` so layout cleanup is part of the
   * service-level contract instead of something every caller has to
   * remember to do as a second step. Keeps `BrowserService` and
   * `ChatService` symmetric. `deleteLayout` is a no-op when no layout row
   * exists, so this is safe across workspaces that never opened a browser.
   */
  removeAllForWorkspace(workspaceId: string): void {
    const ids = this.workspaceBrowsers.get(workspaceId);

    if (ids) {
      for (const browserId of [...ids]) {
        this.browserTabs.delete(browserId);
      }

      this.queries.removeAllForWorkspace(workspaceId);

      this.workspaceBrowsers.delete(workspaceId);
    }

    // Always drop the saved layout, even when no in-memory tabs exist —
    // a row in `browser_layout` can survive a server restart where the
    // workspace's browsers were never hydrated yet.
    this.deleteLayout(workspaceId);

    log.info({ workspaceId }, "all browser tabs removed for workspace");
  }

  /**
   * Load all browser tabs from the database into the in-memory registry.
   * Called on server startup. Resets all statuses to "idle".
   */
  loadFromDb(): number {
    this.initialized = true;
    const now = Date.now();

    // Same bulk-UPDATE pattern as `chatService.loadFromDb` — collapses the
    // per-row status reset into a single SQL statement (one WAL fsync)
    // regardless of tab count. The hydration loop below forces
    // `status: "idle"` on the in-memory copy even when the row was already
    // idle on disk.
    this.queries.resetAllToIdle(now);

    const rows = this.queries.findAll();
    for (const row of rows) {
      const tab: BrowserTab = { ...row, status: "idle" };
      this.addToIndex(tab);
    }

    if (rows.length > 0) {
      log.info({ count: rows.length }, "loaded browser tabs from database");
    }
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Layout integration (absorbed from the now-deleted `lib/browser-layout-manager.ts`)
  // -------------------------------------------------------------------------

  /** Get the saved browser layout tree for a workspace, or null when absent. */
  getLayout(workspaceId: string): unknown | null {
    return this.layoutManager.get(workspaceId);
  }

  /** Upsert the saved browser layout tree for a workspace. */
  saveLayout(workspaceId: string, tree: unknown): void {
    this.layoutManager.save(workspaceId, tree);
  }

  /** Delete the saved browser layout for a workspace. */
  deleteLayout(workspaceId: string): void {
    this.layoutManager.delete(workspaceId);
  }

  /** Add a browser panel to the saved dockview layout. */
  addToLayout(
    workspaceId: string,
    browserId: string,
    opts?: { title?: string; initialUrl?: string },
  ): void {
    this.layoutManager.addPanel(workspaceId, {
      id: browserId,
      contentComponent: "browserTab",
      tabComponent: "browserTab",
      title: opts?.title ?? "New Tab",
      params: {
        workspaceId,
        browserId,
        ...(opts?.initialUrl ? { initialUrl: opts.initialUrl } : {}),
      },
    });
  }

  /** Remove a browser panel from the saved dockview layout. */
  removeFromLayout(workspaceId: string, browserId: string): void {
    this.layoutManager.removePanel(workspaceId, browserId);
  }
}

/**
 * Shared singleton consumed by both the API tier (browsers router) and the
 * back-compat shim in `lib/browser-manager.ts`. The browser service holds
 * in-memory state (the tab registry), so callers MUST go through this
 * instance — instantiating a second `BrowserService` elsewhere would
 * create a phantom registry that doesn't see the other's writes.
 */
export const browserService = new BrowserService();
