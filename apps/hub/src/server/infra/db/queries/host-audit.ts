/** Persistence for `host_audit`: cross-host and admin-only calls agents made through the relay. */

import { desc, lt } from "drizzle-orm";

import { getDb } from "../connection";
import { hostAudit } from "../schema";

export type HostAuditRow = typeof hostAudit.$inferSelect;

export class HostAuditQueries {
  insert(row: Omit<HostAuditRow, "id">): void {
    getDb().insert(hostAudit).values(row).run();
  }

  /** The newest `limit` entries. */
  list(limit: number): HostAuditRow[] {
    return getDb().select().from(hostAudit).orderBy(desc(hostAudit.id)).limit(limit).all();
  }

  /** Deletes entries older than `before` (epoch ms). */
  prune(before: number): void {
    getDb().delete(hostAudit).where(lt(hostAudit.at, before)).run();
  }
}
