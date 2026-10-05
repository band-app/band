/** Persistence for `contexts`. Only `ContextService` calls this. */

import { asc, desc, eq, lt } from "drizzle-orm";
import { getDb } from "../connection";
import { contextEvents, contexts } from "../schema";

export type ContextRow = typeof contexts.$inferSelect;
export type ContextEventRow = typeof contextEvents.$inferSelect;

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

  insertEvent(row: ContextEventRow): void {
    getDb().insert(contextEvents).values(row).run();
  }

  /** Newest first. */
  listEvents(limit: number, context?: string): ContextEventRow[] {
    const q = getDb().select().from(contextEvents);
    return (context ? q.where(eq(contextEvents.context, context)) : q)
      .orderBy(desc(contextEvents.at))
      .limit(limit)
      .all();
  }

  pruneEvents(before: number): void {
    getDb().delete(contextEvents).where(lt(contextEvents.at, before)).run();
  }
}
