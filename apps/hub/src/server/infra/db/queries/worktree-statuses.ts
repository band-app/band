/**
 * Read/write data access for the `worktree_statuses` table.
 *
 * Infra tier — owns the SQL for the worktree-status rows. The service
 * tier (`services/state.ts::upsertWorktreeStatus`) layers the identity
 * self-heal + change-detection logic on top; this module exposes the
 * raw SELECT / UPDATE / INSERT / DELETE primitives.
 *
 * Created to resolve the `TODO(#313 follow-up)` parked in
 * `RepoService.list`, expanded in the #535 cleanup so the write-side
 * SQL leaves `services/state.ts` too.
 */

import { and, eq, notInArray, or } from "drizzle-orm";
import type { WorktreeStatusSnapshot } from "../../events/status-event-bus";
import { getDb } from "../connection";
import {
  worktreeStatuses as worktreeStatusesTable,
  worktreeStatusSources as worktreeStatusSourcesTable,
} from "../schema";

function rowToSnapshot(row: typeof worktreeStatusesTable.$inferSelect): WorktreeStatusSnapshot {
  return {
    worktreeId: row.worktreeId,
    repo: row.repo,
    branch: row.branch,
    worktreePath: row.worktreePath,
    agent: row.agentName
      ? {
          name: row.agentName,
          status: row.agentStatus ?? "unknown",
          lastActivity: row.agentLastActivity ?? "",
          summary: row.agentSummary ?? undefined,
          codingAgentId: row.codingAgentId ?? undefined,
        }
      : undefined,
  };
}

/** Persisted row shape exposed to the services tier for read-modify-write. */
export type WorktreeStatusRow = typeof worktreeStatusesTable.$inferSelect;

/** Field set the services tier writes; matches the schema's mutable columns. */
export interface WorktreeStatusWrite {
  worktreeId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  agentName: string;
  agentStatus: string;
  agentLastActivity: string;
  agentSummary: string | null;
  codingAgentId: string | null;
  updatedAt: number;
}

export interface WorktreeStatusPatch {
  agentName?: string;
  agentStatus?: string;
  agentLastActivity?: string;
  agentSummary?: string | null;
  codingAgentId?: string | null;
  repo?: string;
  branch?: string;
  worktreePath?: string;
  updatedAt: number;
}

export class WorktreeStatusQueries {
  /**
   * Read every worktree status row and translate to the
   * `WorktreeStatusSnapshot` shape consumed by the dashboard.
   *
   * Used by the repo list endpoint (which joins per-worktree agent
   * info into the repos/worktrees tree) and by the watcher's
   * on-subscribe snapshot replay.
   */
  loadCurrent(): WorktreeStatusSnapshot[] {
    const db = getDb();
    const rows = db.select().from(worktreeStatusesTable).all();
    return rows.map(rowToSnapshot);
  }

  /**
   * Look up a single worktree's status row, or `null` when no row
   * exists yet (the worktree was created but no agent has touched it).
   */
  getByWorktreeId(worktreeId: string): WorktreeStatusSnapshot | null {
    const db = getDb();
    const row = db
      .select()
      .from(worktreeStatusesTable)
      .where(eq(worktreeStatusesTable.worktreeId, worktreeId))
      .get();
    if (!row) return null;
    return rowToSnapshot(row);
  }

  /**
   * Raw SELECT of the persisted row. Used by the service-tier upsert
   * path that needs the full row (not the snapshot translation) to
   * decide whether the write is a no-op.
   */
  findRow(worktreeId: string): WorktreeStatusRow | undefined {
    const db = getDb();
    return db
      .select()
      .from(worktreeStatusesTable)
      .where(eq(worktreeStatusesTable.worktreeId, worktreeId))
      .get();
  }

  /** Insert a fresh row. */
  insert(row: WorktreeStatusWrite): void {
    const db = getDb();
    db.insert(worktreeStatusesTable).values(row).run();
  }

  /** Patch an existing row by worktreeId. */
  update(worktreeId: string, patch: WorktreeStatusPatch): void {
    const db = getDb();
    db.update(worktreeStatusesTable)
      .set(patch)
      .where(eq(worktreeStatusesTable.worktreeId, worktreeId))
      .run();
  }

  /** Delete a single row by worktreeId. */
  remove(worktreeId: string): void {
    const db = getDb();
    db.delete(worktreeStatusesTable).where(eq(worktreeStatusesTable.worktreeId, worktreeId)).run();
  }

  /**
   * Reset every "working" / "needs_attention" row back to "waiting" and
   * return the count of affected rows. Used at server startup to clean
   * up stale state from the previous run.
   */
  resetActiveToWaiting(now: number): number {
    const db = getDb();
    const result = db
      .update(worktreeStatusesTable)
      .set({ agentStatus: "waiting", updatedAt: now })
      .where(
        or(
          eq(worktreeStatusesTable.agentStatus, "working"),
          eq(worktreeStatusesTable.agentStatus, "needs_attention"),
        ),
      )
      .run();
    return Number(result.changes);
  }
}

/** One agent's status within a worktree (see `worktreeStatusSources`). */
export interface WorktreeStatusSourceRow {
  worktreeId: string;
  sourceId: string;
  status: string;
  terminalId: string | null;
  updatedAt: number;
}

export class WorktreeStatusSourceQueries {
  /** Insert or replace one source's status. */
  upsert(row: WorktreeStatusSourceRow): void {
    const db = getDb();
    db.insert(worktreeStatusSourcesTable)
      .values(row)
      .onConflictDoUpdate({
        target: [worktreeStatusSourcesTable.worktreeId, worktreeStatusSourcesTable.sourceId],
        set: { status: row.status, terminalId: row.terminalId, updatedAt: row.updatedAt },
      })
      .run();
  }

  /** Every source in the worktree. */
  listForWorktree(worktreeId: string): WorktreeStatusSourceRow[] {
    const db = getDb();
    return db
      .select()
      .from(worktreeStatusSourcesTable)
      .where(eq(worktreeStatusSourcesTable.worktreeId, worktreeId))
      .all();
  }

  /** Every source in every worktree. */
  listAll(): WorktreeStatusSourceRow[] {
    return getDb().select().from(worktreeStatusSourcesTable).all();
  }

  /** Delete one source; returns whether a row existed. */
  remove(worktreeId: string, sourceId: string): boolean {
    const db = getDb();
    const result = db
      .delete(worktreeStatusSourcesTable)
      .where(
        and(
          eq(worktreeStatusSourcesTable.worktreeId, worktreeId),
          eq(worktreeStatusSourcesTable.sourceId, sourceId),
        ),
      )
      .run();
    return Number(result.changes) > 0;
  }

  /** Delete every source reported from a terminal; returns their worktrees. */
  removeForTerminal(terminalId: string): string[] {
    const db = getDb();
    const rows = db
      .delete(worktreeStatusSourcesTable)
      .where(eq(worktreeStatusSourcesTable.terminalId, terminalId))
      .returning({ worktreeId: worktreeStatusSourcesTable.worktreeId })
      .all();
    return [...new Set(rows.map((r) => r.worktreeId))];
  }

  /** Delete every source of a worktree. */
  removeForWorktree(worktreeId: string): void {
    const db = getDb();
    db.delete(worktreeStatusSourcesTable)
      .where(eq(worktreeStatusSourcesTable.worktreeId, worktreeId))
      .run();
  }

  /** Delete every source. Used at server startup: no agent state survives it. */
  removeAll(): void {
    getDb().delete(worktreeStatusSourcesTable).run();
  }

  /**
   * Set the worktree's `needs_attention` sources to `waiting`, except the
   * ones in `keep`.
   */
  acknowledge(worktreeId: string, keep: string[], now: number): void {
    const db = getDb();
    const conditions = [
      eq(worktreeStatusSourcesTable.worktreeId, worktreeId),
      eq(worktreeStatusSourcesTable.status, "needs_attention"),
    ];
    if (keep.length > 0) conditions.push(notInArray(worktreeStatusSourcesTable.sourceId, keep));
    db.update(worktreeStatusSourcesTable)
      .set({ status: "waiting", updatedAt: now })
      .where(and(...conditions))
      .run();
  }
}
