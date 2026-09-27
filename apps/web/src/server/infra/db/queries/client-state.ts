/**
 * Persistence for client state (`client_state`): small JSON UI values keyed
 * by `(key, scope)`, versioned so a write based on a stale version is
 * refused instead of overwriting a newer value.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ClientStateEntry, ClientStateScope } from "../../../../shared/client-state";
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

export interface ClientStateWrite {
  key: string;
  scope: ClientStateScope;
  workspaceId: string | null;
  /** Serialized JSON, or null to delete (the row stays as a tombstone). */
  value: string | null;
  baseVersion: number;
  updatedAt: number;
}

export class ClientStateQueries {
  /** Every row of one workspace (or the global rows when null) in the given scopes. */
  list(workspaceId: string | null, scopes: ClientStateScope[]): ClientStateEntry[] {
    const where = and(
      workspaceId === null
        ? isNull(clientState.workspaceId)
        : eq(clientState.workspaceId, workspaceId),
      inArray(clientState.scope, scopes),
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

  /**
   * Write the row if its current version equals `baseVersion` (0 when the
   * row doesn't exist yet). Returns the stored row and whether the write
   * happened; on a refused write the row is the current one, unchanged.
   */
  compareAndSet(write: ClientStateWrite): { ok: boolean; entry: ClientStateEntry } {
    return getDb().transaction((tx) => {
      const where = and(eq(clientState.key, write.key), eq(clientState.scope, write.scope));
      const current = tx.select().from(clientState).where(where).get();
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== write.baseVersion) {
        if (current) return { ok: false, entry: toEntry(current) };
        // No row, but the client thinks there is one (e.g. its workspace was
        // deleted and recreated). Report an empty tombstone at version 0 so the
        // client rebases onto "nothing stored".
        return {
          ok: false,
          entry: {
            key: write.key,
            scope: write.scope,
            workspaceId: write.workspaceId,
            value: null,
            version: 0,
            updatedAt: write.updatedAt,
          },
        };
      }
      const row: Row = {
        key: write.key,
        scope: write.scope,
        workspaceId: write.workspaceId,
        value: write.value,
        version: currentVersion + 1,
        updatedAt: write.updatedAt,
      };
      if (current) {
        tx.update(clientState)
          .set({
            workspaceId: row.workspaceId,
            value: row.value,
            version: row.version,
            updatedAt: row.updatedAt,
          })
          .where(where)
          .run();
      } else {
        tx.insert(clientState).values(row).run();
      }
      return { ok: true, entry: toEntry(row) };
    });
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
