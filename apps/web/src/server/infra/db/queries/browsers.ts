/**
 * Typed persistence layer for browser tabs.
 *
 * Wraps the generic `panel-states` infra primitive with the browser-specific
 * JSON shape so the service tier can hand the queries a fully-typed
 * `BrowserRow` instead of stringly-typed JSON blobs. Mirrors
 * `chats.ts` — see that file for the motivation behind splitting Infra
 * (JSON↔row mapping) from Services (business rules, in-memory cache).
 *
 * Created in issue #316 (Phase 5 of the 3-tier refactor) by lifting the
 * persistence half of `lib/browser-manager.ts` out of the manager and into
 * this class.
 */

import {
  deletePanelState,
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStates,
  resetPanelStatesToIdle,
  updatePanelState,
} from "./panel-states";

/** `panel_states.panelType` value used for browser-tab rows. */
export const BROWSER_PANEL_TYPE = "browser";

/**
 * Browser tab status as persisted in the `state` JSON blob's `status` field.
 *
 * Mirrors the runtime status the browser-service hands the dashboard.
 * Stored on disk so a server restart can deterministically reset every
 * browser to `"idle"` (see `resetAllToIdle`).
 */
export type BrowserStatus = "idle" | "loading" | "error";

/**
 * Domain-typed view of a browser-tab row.
 *
 * The on-disk JSON blob is pre-decoded by `findAll`; callers get a flat
 * record they can hand the service's in-memory `Map<string, BrowserRow>`
 * without any further parsing. Browsers don't use the `labels` column —
 * see `chats.ts` for the typed labels equivalent.
 */
export interface BrowserRow {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  status: BrowserStatus;
}

/**
 * Patch applied by `update` — every field is optional so cosmetic edits
 * (e.g. navigating to a new URL) don't have to read the row first.
 */
export interface BrowserUpdatePatch {
  name?: string;
  url?: string;
  status?: BrowserStatus;
}

/**
 * Shape of the JSON blob stored in `panel_states.state` for browser rows.
 *
 * Mirrors `BrowserRow` minus the `id`/`workspaceId` keys (those live on
 * the row itself).
 */
interface BrowserStateBlob {
  name: string;
  url: string;
  status: BrowserStatus;
}

function serializeState(row: { name: string; url: string; status: BrowserStatus }): string {
  const blob: BrowserStateBlob = {
    name: row.name,
    url: row.url,
    status: row.status,
  };
  return JSON.stringify(blob);
}

/**
 * Persistence operations for the browser half of the `panel_states` table.
 *
 * Stateless — every method reads/writes the DB directly, no in-process
 * cache. The browser service owns the in-memory `Map<browserId, BrowserRow>`
 * and decides when to call into here.
 */
export class BrowserQueries {
  /** Insert a new browser-tab row. */
  insert(row: BrowserRow & { createdAt: number; updatedAt: number }): void {
    insertPanelState({
      id: row.id,
      workspaceId: row.workspaceId,
      panelType: BROWSER_PANEL_TYPE,
      state: serializeState(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  /**
   * Apply a patch. The patch may touch any subset of fields; the SQL UPDATE
   * always rewrites the full `state` blob (it's a single JSON column, so
   * partial writes would need `json_set` per-field — not worth it for the
   * common case of "update everything that changed").
   *
   * `current` is the in-memory snapshot the service holds — passing it
   * avoids a SELECT round-trip just to merge the patch.
   *
   * Returns the merged shape so the service can update its in-memory copy
   * without re-computing the merge.
   */
  update(
    id: string,
    current: BrowserRow,
    patch: BrowserUpdatePatch & { updatedAt: number },
  ): BrowserRow {
    const merged: BrowserRow = {
      ...current,
      name: patch.name ?? current.name,
      url: patch.url ?? current.url,
      status: patch.status ?? current.status,
    };
    updatePanelState(id, {
      state: serializeState(merged),
      updatedAt: patch.updatedAt,
    });
    return merged;
  }

  /** Delete a single browser-tab row. */
  remove(id: string): void {
    deletePanelState(id);
  }

  /** Delete every browser-tab row for a workspace. */
  removeAllForWorkspace(workspaceId: string): void {
    deletePanelStatesForWorkspace(workspaceId, BROWSER_PANEL_TYPE);
  }

  /**
   * Read every browser-tab row from disk. Each row's JSON `state` is
   * parsed into the typed `BrowserRow` shape; malformed rows throw — the
   * service hydrates once at boot, so a bad row is a fatal config error
   * worth surfacing loudly rather than silently dropping.
   */
  findAll(): BrowserRow[] {
    const rows = listPanelStates(BROWSER_PANEL_TYPE);
    const out: BrowserRow[] = [];
    for (const row of rows) {
      const parsed = JSON.parse(row.state) as BrowserStateBlob;
      out.push({
        id: row.id,
        workspaceId: row.workspaceId,
        name: parsed.name,
        url: parsed.url,
        status: parsed.status,
      });
    }
    return out;
  }

  /**
   * Reset every browser-tab row's persisted `status` to `"idle"` in a
   * single SQL UPDATE. Called once on server boot — see `panel-states.ts`
   * for the `json_set`/`json_extract` rationale and NULL-safety notes.
   */
  resetAllToIdle(updatedAt: number): void {
    resetPanelStatesToIdle(BROWSER_PANEL_TYPE, updatedAt);
  }
}
