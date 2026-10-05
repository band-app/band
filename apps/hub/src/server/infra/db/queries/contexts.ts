/** Persistence for `contexts`. Only `ContextService` calls this. */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { contexts } from "../schema";

export type ContextRow = typeof contexts.$inferSelect;

export class ContextQueries {
  list(): ContextRow[] {
    return getDb().select().from(contexts).orderBy(asc(contexts.createdAt)).all();
  }

  find(name: string): ContextRow | undefined {
    return getDb().select().from(contexts).where(eq(contexts.name, name)).get();
  }

  findUser(): ContextRow | undefined {
    return getDb().select().from(contexts).where(eq(contexts.kind, "user")).get();
  }

  insert(row: ContextRow): void {
    getDb().insert(contexts).values(row).run();
  }

  update(name: string, patch: Partial<Omit<ContextRow, "id" | "name">>): void {
    getDb().update(contexts).set(patch).where(eq(contexts.name, name)).run();
  }

  remove(name: string): boolean {
    const result = getDb().delete(contexts).where(eq(contexts.name, name)).run();
    return Number(result.changes ?? 0) > 0;
  }
}
