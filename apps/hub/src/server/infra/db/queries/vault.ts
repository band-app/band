/**
 * Persistence for `vault_items`. Rows hold an encrypted blob and metadata
 * without secrets. Only `VaultService` calls this.
 */

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { vaultItems } from "../schema";

export type VaultRow = typeof vaultItems.$inferSelect;
export type VaultKind = VaultRow["kind"];

export class VaultQueries {
  list(): VaultRow[] {
    return getDb().select().from(vaultItems).orderBy(asc(vaultItems.createdAt)).all();
  }

  find(id: string): VaultRow | undefined {
    return getDb().select().from(vaultItems).where(eq(vaultItems.id, id)).get();
  }

  findByName(scope: string, name: string): VaultRow | undefined {
    return getDb()
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.scope, scope), eq(vaultItems.name, name)))
      .get();
  }

  insert(row: VaultRow): void {
    getDb().insert(vaultItems).values(row).run();
  }

  update(id: string, patch: Partial<Omit<VaultRow, "id">>): void {
    getDb().update(vaultItems).set(patch).where(eq(vaultItems.id, id)).run();
  }

  remove(id: string): void {
    getDb().delete(vaultItems).where(eq(vaultItems.id, id)).run();
  }

  /** Runs `fn` in one SQLite transaction; everything rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    return getDb().transaction(() => fn() as never) as T;
  }
}
