/**
 * Generic CRUD layer for the `panel_states` table.
 *
 * Panel-type-specific managers (e.g. chat-manager) delegate their DB
 * operations here, serializing domain state into the JSON `state` column.
 * This keeps the persistence layer reusable across panel types without
 * requiring a dedicated table per type.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db/connection";
import { panelStates } from "./db/schema";

export interface PanelStateRow {
  id: string;
  workspaceId: string;
  panelType: string;
  state: string; // raw JSON string
  /**
   * Free-form labels for this panel. JSON-encoded `Record<string, string>` on
   * disk; `null` (or absent) for legacy rows and panel types that don't use
   * labels — readers should treat both as `{}`. See `chat-manager.ts` for
   * validation rules — the store itself is intentionally schema-agnostic so
   * other panel types can adopt labels without changes here.
   */
  labels?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Insert a new panel state row. */
export function insertPanelState(row: PanelStateRow): void {
  const db = getDb();
  // Normalize undefined → null so SQLite stores a real NULL rather than the
  // string "undefined" when the caller doesn't supply labels.
  db.insert(panelStates)
    .values({ ...row, labels: row.labels ?? null })
    .run();
}

/** Update a panel state row's state blob and updatedAt. */
export function updatePanelState(
  id: string,
  updates: { state: string; updatedAt: number; labels?: string | null },
): void {
  const db = getDb();
  db.update(panelStates).set(updates).where(eq(panelStates.id, id)).run();
}

/** Delete a single panel state row by id. */
export function deletePanelState(id: string): void {
  const db = getDb();
  db.delete(panelStates).where(eq(panelStates.id, id)).run();
}

/**
 * Delete all panel state rows for a workspace.
 * If `panelType` is provided, only deletes rows of that type.
 */
export function deletePanelStatesForWorkspace(workspaceId: string, panelType?: string): void {
  const db = getDb();
  if (panelType) {
    db.delete(panelStates)
      .where(and(eq(panelStates.workspaceId, workspaceId), eq(panelStates.panelType, panelType)))
      .run();
  } else {
    db.delete(panelStates).where(eq(panelStates.workspaceId, workspaceId)).run();
  }
}

/** List all panel state rows of a given type (across all workspaces). */
export function listPanelStates(panelType: string): PanelStateRow[] {
  const db = getDb();
  return db.select().from(panelStates).where(eq(panelStates.panelType, panelType)).all();
}

/** List panel state rows for a specific workspace and type. */
export function listPanelStatesForWorkspace(
  workspaceId: string,
  panelType: string,
): PanelStateRow[] {
  const db = getDb();
  return db
    .select()
    .from(panelStates)
    .where(and(eq(panelStates.workspaceId, workspaceId), eq(panelStates.panelType, panelType)))
    .all();
}

/**
 * Reset the `status` field inside the JSON `state` blob to `"idle"` for every
 * row of the given panel type whose current `status` is something else.
 *
 * Uses SQLite's `json_set` / `json_extract` so the rewrite happens in a
 * single SQL `UPDATE` regardless of row count — replacing what used to be
 * N per-row UPDATEs (each a separate WAL fsync) issued by the
 * `loadChatsFromDb` / `loadBrowsersFromDb` boot path. The guard avoids
 * touching rows that are already idle so a clean reboot doesn't bump
 * `updated_at` for the bulk of the panel registry.
 *
 * NULL-safety: the guard uses SQL's `IS NOT` operator rather than `!=` so
 * rows whose JSON blob is missing the `status` key (NULL from
 * `json_extract`) are *included* in the update. With `!=`, SQLite's
 * three-valued logic would make `NULL != 'idle'` evaluate to NULL (falsy),
 * silently skipping those rows. Every current insertion path writes a
 * `status` field, but a migrated or hand-edited row could slip through —
 * `IS NOT` closes the gap with zero runtime cost.
 *
 * The in-memory hydration loop in the callers also forces `status: "idle"`
 * in the local object literal, so even a row that escapes the UPDATE
 * surfaces in memory as idle.
 */
export function resetPanelStatesToIdle(panelType: string, updatedAt: number): void {
  const db = getDb();
  db.update(panelStates)
    .set({
      state: sql`json_set(${panelStates.state}, '$.status', 'idle')`,
      updatedAt,
    })
    .where(
      and(
        eq(panelStates.panelType, panelType),
        sql`json_extract(${panelStates.state}, '$.status') IS NOT 'idle'`,
      ),
    )
    .run();
}
