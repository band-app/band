/** Persistence for `dispatch_requests`. `ProjectDispatchService` calls this. */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { dispatchRequests } from "../schema";

export type DispatchRequestRow = typeof dispatchRequests.$inferSelect;

export class DispatchRequestQueries {
  insertRequest(row: DispatchRequestRow): void {
    getDb().insert(dispatchRequests).values(row).run();
  }

  findRequest(id: string): DispatchRequestRow | undefined {
    return getDb().select().from(dispatchRequests).where(eq(dispatchRequests.id, id)).get();
  }

  requestsOf(projectId: string, status?: string): DispatchRequestRow[] {
    const where = status
      ? and(eq(dispatchRequests.projectId, projectId), eq(dispatchRequests.status, status))
      : eq(dispatchRequests.projectId, projectId);
    return getDb()
      .select()
      .from(dispatchRequests)
      .where(where)
      .orderBy(desc(dispatchRequests.createdAt))
      .limit(100)
      .all();
  }

  /** Moves a pending request to `status`. False when it was already decided, so two decisions cannot both win. */
  decide(
    id: string,
    status: "approved" | "rejected" | "failed",
    patch: { error?: string | null; result?: Record<string, unknown> | null } = {},
  ): boolean {
    const res = getDb()
      .update(dispatchRequests)
      .set({
        status,
        decidedAt: Date.now(),
        error: patch.error ?? null,
        result: patch.result ?? null,
      })
      .where(and(eq(dispatchRequests.id, id), eq(dispatchRequests.status, "pending")))
      .run();
    return Number(res.changes ?? 0) > 0;
  }

  /** Records the outcome of an approved dispatch, once it has run. */
  finish(
    id: string,
    status: "approved" | "failed",
    patch: { error?: string; result?: Record<string, unknown> },
  ): void {
    getDb()
      .update(dispatchRequests)
      .set({ status, error: patch.error ?? null, result: patch.result ?? null })
      .where(eq(dispatchRequests.id, id))
      .run();
  }
}
