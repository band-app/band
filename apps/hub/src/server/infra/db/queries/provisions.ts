/**
 * Persistence for `host_provisions`. A code is spent by a guarded update (`spent_at IS NULL`),
 * so of two concurrent exchanges only one wins.
 */

import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "../connection";
import { hostProvisions } from "../schema";

export type ProvisionRow = typeof hostProvisions.$inferSelect;
export type ProvisionState = ProvisionRow["state"];

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update" | "delete">;

export class ProvisionQueries {
  constructor(private readonly db: () => Db = getDb) {}

  insert(row: ProvisionRow): void {
    this.db().insert(hostProvisions).values(row).run();
  }

  findById(id: string): ProvisionRow | undefined {
    return this.db().select().from(hostProvisions).where(eq(hostProvisions.id, id)).get();
  }

  findByCodeHash(hash: string): ProvisionRow | undefined {
    return this.db().select().from(hostProvisions).where(eq(hostProvisions.codeHash, hash)).get();
  }

  list(limit: number): ProvisionRow[] {
    return this.db()
      .select()
      .from(hostProvisions)
      .orderBy(desc(hostProvisions.createdAt))
      .limit(limit)
      .all();
  }

  /** Marks a pending code as spent and records the host and run token. Returns whether this call won. */
  spend(id: string, at: number, hostId: string, runHash: string): boolean {
    const result = this.db()
      .update(hostProvisions)
      .set({ spentAt: at, hostId, runHash, state: "running", updatedAt: at })
      .where(and(eq(hostProvisions.id, id), isNull(hostProvisions.spentAt)))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  setLog(id: string, log: string, at: number): void {
    this.db()
      .update(hostProvisions)
      .set({ log, updatedAt: at })
      .where(eq(hostProvisions.id, id))
      .run();
  }

  finish(id: string, state: ProvisionState, exitCode: number, log: string, at: number): void {
    this.db()
      .update(hostProvisions)
      .set({ state, exitCode, log, updatedAt: at })
      .where(eq(hostProvisions.id, id))
      .run();
  }

  /** Ids of rows created before `at`, so their bundle files can be deleted. */
  idsCreatedBefore(at: number): string[] {
    return this.db()
      .select({ id: hostProvisions.id })
      .from(hostProvisions)
      .where(lt(hostProvisions.createdAt, at))
      .all()
      .map((r) => r.id);
  }
}
