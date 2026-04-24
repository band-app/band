/**
 * Generic CRUD layer for the `panel_states` table.
 *
 * Panel-type-specific managers (e.g. chat-manager) delegate their DB
 * operations here, serializing domain state into the JSON `state` column.
 * This keeps the persistence layer reusable across panel types without
 * requiring a dedicated table per type.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "./db/connection";
import { panelStates } from "./db/schema";

export interface PanelStateRow {
  id: string;
  workspaceId: string;
  panelType: string;
  state: string; // raw JSON string
  createdAt: number;
  updatedAt: number;
}

/** Insert a new panel state row. */
export function insertPanelState(row: PanelStateRow): void {
  const db = getDb();
  db.insert(panelStates).values(row).run();
}

/** Update a panel state row's state blob and updatedAt. */
export function updatePanelState(
  id: string,
  updates: { state: string; updatedAt: number },
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
export function deletePanelStatesForWorkspace(
  workspaceId: string,
  panelType?: string,
): void {
  const db = getDb();
  if (panelType) {
    db.delete(panelStates)
      .where(
        and(
          eq(panelStates.workspaceId, workspaceId),
          eq(panelStates.panelType, panelType),
        ),
      )
      .run();
  } else {
    db.delete(panelStates)
      .where(eq(panelStates.workspaceId, workspaceId))
      .run();
  }
}

/** List all panel state rows of a given type (across all workspaces). */
export function listPanelStates(panelType: string): PanelStateRow[] {
  const db = getDb();
  return db
    .select()
    .from(panelStates)
    .where(eq(panelStates.panelType, panelType))
    .all();
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
    .where(
      and(
        eq(panelStates.workspaceId, workspaceId),
        eq(panelStates.panelType, panelType),
      ),
    )
    .all();
}
