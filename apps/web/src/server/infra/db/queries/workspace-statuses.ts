/**
 * Read/write data access for the `workspace_statuses` table.
 *
 * Infra tier — owns the SQL for the workspace-status rows. The service
 * tier (`services/state.ts::upsertWorkspaceStatus`) layers the identity
 * self-heal + change-detection logic on top; this module exposes the
 * raw SELECT / UPDATE / INSERT / DELETE primitives.
 *
 * Created to resolve the `TODO(#313 follow-up)` parked in
 * `ProjectService.list`, expanded in the #535 cleanup so the write-side
 * SQL leaves `services/state.ts` too.
 */

import { eq, or } from "drizzle-orm";
import type { WorkspaceStatusSnapshot } from "../../events/status-event-bus";
import { getDb } from "../connection";
import { workspaceStatuses as workspaceStatusesTable } from "../schema";

function rowToSnapshot(row: typeof workspaceStatusesTable.$inferSelect): WorkspaceStatusSnapshot {
  return {
    workspaceId: row.workspaceId,
    project: row.project,
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
export type WorkspaceStatusRow = typeof workspaceStatusesTable.$inferSelect;

/** Field set the services tier writes; matches the schema's mutable columns. */
export interface WorkspaceStatusWrite {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  agentName: string;
  agentStatus: string;
  agentLastActivity: string;
  agentSummary: string | null;
  codingAgentId: string | null;
  updatedAt: number;
}

export interface WorkspaceStatusPatch {
  agentName?: string;
  agentStatus?: string;
  agentLastActivity?: string;
  agentSummary?: string | null;
  codingAgentId?: string | null;
  project?: string;
  branch?: string;
  worktreePath?: string;
  updatedAt: number;
}

export class WorkspaceStatusQueries {
  /**
   * Read every workspace status row and translate to the
   * `WorkspaceStatusSnapshot` shape consumed by the dashboard.
   *
   * Used by the project list endpoint (which joins per-workspace agent
   * info into the projects/worktrees tree) and by the watcher's
   * on-subscribe snapshot replay.
   */
  loadCurrent(): WorkspaceStatusSnapshot[] {
    const db = getDb();
    const rows = db.select().from(workspaceStatusesTable).all();
    return rows.map(rowToSnapshot);
  }

  /**
   * Look up a single workspace's status row, or `null` when no row
   * exists yet (the workspace was created but no agent has touched it).
   */
  getByWorkspaceId(workspaceId: string): WorkspaceStatusSnapshot | null {
    const db = getDb();
    const row = db
      .select()
      .from(workspaceStatusesTable)
      .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
      .get();
    if (!row) return null;
    return rowToSnapshot(row);
  }

  /**
   * Raw SELECT of the persisted row. Used by the service-tier upsert
   * path that needs the full row (not the snapshot translation) to
   * decide whether the write is a no-op.
   */
  findRow(workspaceId: string): WorkspaceStatusRow | undefined {
    const db = getDb();
    return db
      .select()
      .from(workspaceStatusesTable)
      .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
      .get();
  }

  /** Insert a fresh row. */
  insert(row: WorkspaceStatusWrite): void {
    const db = getDb();
    db.insert(workspaceStatusesTable).values(row).run();
  }

  /** Patch an existing row by workspaceId. */
  update(workspaceId: string, patch: WorkspaceStatusPatch): void {
    const db = getDb();
    db.update(workspaceStatusesTable)
      .set(patch)
      .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
      .run();
  }

  /** Delete a single row by workspaceId. */
  remove(workspaceId: string): void {
    const db = getDb();
    db.delete(workspaceStatusesTable)
      .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
      .run();
  }

  /**
   * Reset every "working" / "needs_attention" row back to "waiting" and
   * return the count of affected rows. Used at server startup to clean
   * up stale state from the previous run.
   */
  resetActiveToWaiting(now: number): number {
    const db = getDb();
    const result = db
      .update(workspaceStatusesTable)
      .set({ agentStatus: "waiting", updatedAt: now })
      .where(
        or(
          eq(workspaceStatusesTable.agentStatus, "working"),
          eq(workspaceStatusesTable.agentStatus, "needs_attention"),
        ),
      )
      .run();
    return Number(result.changes);
  }
}
