/**
 * Persistence for client state (`client_state`): small JSON UI values keyed
 * by `(key, scope)`. Each write is a single statement guarded by the row's
 * version, so a write based on a stale version changes nothing.
 */

import type { ClientStateEntry, ClientStateScope } from "@band-app/shared/client-state";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import { clientState } from "../schema";

type Row = typeof clientState.$inferSelect;

function toEntry(row: Row): ClientStateEntry {
  let value: unknown = null;
  if (row.value != null) {
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
  }
  return {
    key: row.key,
    scope: row.scope,
    workspaceId: row.workspaceId,
    value,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export class ClientStateQueries {
  /** Live rows (not tombstones) of one workspace, or the global rows when null, in the given scopes. */
  list(workspaceId: string | null, scopes: ClientStateScope[]): ClientStateEntry[] {
    const where = and(
      workspaceId === null
        ? isNull(clientState.workspaceId)
        : eq(clientState.workspaceId, workspaceId),
      inArray(clientState.scope, scopes),
      isNotNull(clientState.value),
    );
    return getDb().select().from(clientState).where(where).all().map(toEntry);
  }

  find(key: string, scope: ClientStateScope): ClientStateEntry | undefined {
    const row = getDb()
      .select()
      .from(clientState)
      .where(and(eq(clientState.key, key), eq(clientState.scope, scope)))
      .get();
    return row ? toEntry(row) : undefined;
  }

  /** Insert the row unless `(key, scope)` exists. Returns whether it was inserted. */
  insertIfAbsent(row: Row): boolean {
    const result = getDb().insert(clientState).values(row).onConflictDoNothing().run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Set value and version where the row is at `fromVersion`. Returns whether it matched. */
  updateIfVersion(
    key: string,
    scope: ClientStateScope,
    fromVersion: number,
    set: { value: string | null; version: number; updatedAt: number },
  ): boolean {
    const result = getDb()
      .update(clientState)
      .set(set)
      .where(
        and(
          eq(clientState.key, key),
          eq(clientState.scope, scope),
          eq(clientState.version, fromVersion),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Delete every row of a workspace. Returns the number removed. */
  removeForWorkspace(workspaceId: string): number {
    const result = getDb()
      .delete(clientState)
      .where(eq(clientState.workspaceId, workspaceId))
      .run();
    return Number(result.changes ?? 0);
  }
}
