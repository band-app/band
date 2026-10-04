/**
 * Persistence for `host_requests`. Every state change is one guarded SQL
 * statement (the `WHERE` names the states it may start from), so two callers
 * racing for a request can't both win.
 */

import { and, asc, count, desc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { getDb } from "../connection";
import { hostRequests, worktrees } from "../schema";

export type HostRequestRow = typeof hostRequests.$inferSelect;
export type HostRequestStatus = HostRequestRow["status"];

export class HostRequestQueries {
  insert(row: HostRequestRow): void {
    getDb().insert(hostRequests).values(row).run();
  }

  get(id: string): HostRequestRow | undefined {
    return getDb().select().from(hostRequests).where(eq(hostRequests.id, id)).get();
  }

  /** The newest request for a workspace that has not been cancelled or failed. */
  findOpenForWorkspace(workspaceId: string): HostRequestRow | undefined {
    return getDb()
      .select()
      .from(hostRequests)
      .where(
        and(
          eq(hostRequests.workspaceId, workspaceId),
          inArray(hostRequests.status, ["pending", "leased", "fulfilled"]),
          isNull(hostRequests.completedAt),
        ),
      )
      .orderBy(desc(hostRequests.createdAt))
      .get();
  }

  /** The newest request that was fulfilled with this host. */
  latestForHost(hostId: string): HostRequestRow | undefined {
    return getDb()
      .select()
      .from(hostRequests)
      .where(and(eq(hostRequests.hostId, hostId), eq(hostRequests.status, "fulfilled")))
      .orderBy(desc(hostRequests.createdAt))
      .get();
  }

  /** Requests the UI shows: not cancelled, and not yet turned into a workspace. */
  listActive(): HostRequestRow[] {
    return getDb()
      .select()
      .from(hostRequests)
      .where(and(ne(hostRequests.status, "cancelled"), isNull(hostRequests.completedAt)))
      .orderBy(asc(hostRequests.createdAt))
      .all();
  }

  /** Fulfilled requests whose workspace is not created yet. */
  listAwaitingHost(): HostRequestRow[] {
    return getDb()
      .select()
      .from(hostRequests)
      .where(and(eq(hostRequests.status, "fulfilled"), isNull(hostRequests.completedAt)))
      .all();
  }

  /** Requests a runner could take now, oldest first. */
  listLeasable(now: number): HostRequestRow[] {
    return getDb()
      .select()
      .from(hostRequests)
      .where(
        or(
          eq(hostRequests.status, "pending"),
          and(eq(hostRequests.status, "leased"), lt(hostRequests.leaseExpiresAt, now)),
        ),
      )
      .orderBy(asc(hostRequests.createdAt))
      .all();
  }

  /** Puts leases that ran out back to `pending`. Returns the ids. */
  releaseExpired(now: number): string[] {
    return getDb()
      .update(hostRequests)
      .set({ status: "pending", leasedBy: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(hostRequests.status, "leased"), lt(hostRequests.leaseExpiresAt, now)))
      .returning({ id: hostRequests.id })
      .all()
      .map((r) => r.id);
  }

  /** Leases one specific request if it is still leasable. Returns whether this call took it. */
  lease(id: string, runnerId: string, now: number, expiresAt: number): boolean {
    const result = getDb()
      .update(hostRequests)
      .set({ status: "leased", leasedBy: runnerId, leaseExpiresAt: expiresAt, updatedAt: now })
      .where(
        and(
          eq(hostRequests.id, id),
          or(
            eq(hostRequests.status, "pending"),
            and(eq(hostRequests.status, "leased"), lt(hostRequests.leaseExpiresAt, now)),
          ),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Extends a live lease held by `runnerId`. */
  renew(id: string, runnerId: string, now: number, expiresAt: number): boolean {
    const result = getDb()
      .update(hostRequests)
      .set({ leaseExpiresAt: expiresAt, updatedAt: now })
      .where(
        and(
          eq(hostRequests.id, id),
          eq(hostRequests.status, "leased"),
          eq(hostRequests.leasedBy, runnerId),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Marks a leased request fulfilled by `hostId`. */
  fulfil(
    id: string,
    runnerId: string,
    hostId: string,
    now: number,
    input?: Record<string, unknown>,
  ): boolean {
    const result = getDb()
      .update(hostRequests)
      .set({ status: "fulfilled", hostId, updatedAt: now, ...(input ? { input } : {}) })
      .where(
        and(
          eq(hostRequests.id, id),
          eq(hostRequests.status, "leased"),
          eq(hostRequests.leasedBy, runnerId),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Fails a request that is not finished yet. */
  fail(id: string, error: string, now: number): boolean {
    const result = getDb()
      .update(hostRequests)
      .set({ status: "failed", error, updatedAt: now })
      .where(
        and(
          eq(hostRequests.id, id),
          inArray(hostRequests.status, ["pending", "leased", "fulfilled"]),
          isNull(hostRequests.completedAt),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Cancels a request that has not become a workspace. */
  cancel(id: string, now: number): boolean {
    const result = getDb()
      .update(hostRequests)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(hostRequests.id, id),
          ne(hostRequests.status, "cancelled"),
          isNull(hostRequests.completedAt),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Records that the workspace now exists. Guarded so a cancel that won stays cancelled. */
  complete(id: string, now: number): boolean {
    const result = getDb()
      .update(hostRequests)
      .set({ completedAt: now, updatedAt: now })
      .where(
        and(
          eq(hostRequests.id, id),
          eq(hostRequests.status, "fulfilled"),
          isNull(hostRequests.completedAt),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Requests still waiting for a host past `cutoff`. A pending or leased request
   * counts from its creation, a fulfilled one from the moment it was fulfilled,
   * so a long wait for a runner doesn't shorten the time the host has to connect.
   */
  listTimedOut(cutoff: number): HostRequestRow[] {
    return getDb()
      .select()
      .from(hostRequests)
      .where(
        and(
          isNull(hostRequests.completedAt),
          or(
            and(
              inArray(hostRequests.status, ["pending", "leased"]),
              lt(hostRequests.createdAt, cutoff),
            ),
            and(eq(hostRequests.status, "fulfilled"), lt(hostRequests.updatedAt, cutoff)),
          ),
        ),
      )
      .all();
  }

  /** Number of worktrees on each host, for picking the least loaded one. */
  worktreeCounts(): Map<string, number> {
    const rows = getDb()
      .select({ hostId: worktrees.hostId, n: count() })
      .from(worktrees)
      .groupBy(worktrees.hostId)
      .all();
    return new Map(rows.map((r) => [r.hostId, Number(r.n)]));
  }
}
