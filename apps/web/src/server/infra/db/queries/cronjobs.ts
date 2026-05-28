import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { cronjobs } from "../schema";

/**
 * One scheduled cron-style task — a prompt the agent runs on a recurring
 * schedule against a project's main branch or a specific workspace.
 *
 * Persisted shape matches the Drizzle row 1:1; the `workspaceId` and
 * `lastRun*` columns are nullable in SQLite but exposed here as optional
 * `T | undefined` to make consumers' optional-chaining ergonomic. Conversion
 * happens inside `CronjobQueries.rowToDefinition` below.
 */
export type CronjobScope = "project" | "workspace";

export interface CronjobDefinition {
  /** Unique identifier, e.g. "cj_1710000000000_a1b2c3d4" */
  id: string;
  /** Human-readable name for the job */
  name: string;
  /** The prompt sent to the coding agent */
  prompt: string;
  /** Standard cron expression (5-field format) */
  cronExpression: string;
  /** Whether this runs on the project's main branch or a specific workspace */
  scope: CronjobScope;
  /** For workspace-scoped jobs, the workspace ID (project-branch) */
  workspaceId?: string;
  /** Whether the job is enabled */
  enabled: boolean;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last execution (if any) */
  lastRunAt?: string;
  /** Status of the last execution */
  lastRunStatus?: "completed" | "failed" | "skipped";
}

/**
 * The set of jobs that share a `fileKey` (project name or workspace id).
 *
 * Kept as an object (rather than a bare `CronjobDefinition[]`) because this
 * shape is the tRPC response payload of `cronjobs.list` / `cronjobs.get`:
 * the dashboard's cronjob editor reads `.jobs` and the wrapper leaves room
 * to add per-file metadata later without breaking the client contract.
 * Internally `CronjobQueries` and `CronjobService` always go through this
 * type rather than passing bare arrays, so the wire shape and the
 * in-process shape stay in sync.
 */
export interface CronjobFile {
  jobs: CronjobDefinition[];
}

/**
 * Mint a process-unique cronjob id.
 *
 * `Date.now()` alone is not enough: the integration tests issue several
 * sequential `cronjobs.create` calls inside the same millisecond, and the
 * legacy `saveFile` delete-then-insert pattern would silently drop the
 * earlier row on a collision. Appending 8 hex chars from `randomBytes(4)`
 * gives ~4 billion possibilities per millisecond, which is comfortably
 * collision-free for any realistic UI- or test-driven create rate. Kept as
 * a top-level helper (rather than a class method) so the service tier can
 * call it without instantiating `CronjobQueries`. It lives in the Infra
 * file so the schema shape (`cj_*` prefix is implicit table convention)
 * stays colocated with the rest of the row plumbing.
 */
export function generateCronjobId(): string {
  return `cj_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/**
 * Database-backed data access for `cronjobs`.
 *
 * Infra tier — knows nothing about services or routers. The class is a
 * thin wrapper around Drizzle calls; the calling service layer
 * (`CronjobService`) handles the scheduling lifecycle and the chat-routing
 * logic that the legacy `lib/cronjob-scheduler.ts` mixed in with persistence.
 *
 * Methods are intentionally aligned with the legacy `lib/cronjob-store.ts`
 * helpers so the service tier can be a near-mechanical port of the existing
 * router code. The one shape difference is `listAll()` returns
 * `CronjobDefinition & { fileKey }` because callers (the scheduler in
 * particular) need both pieces to resolve which workspace to fire into.
 */
export class CronjobQueries {
  /** Load all jobs for a specific key (project name or workspace id). */
  loadFile(key: string): CronjobFile {
    const db = getDb();
    const rows = db.select().from(cronjobs).where(eq(cronjobs.fileKey, key)).all();
    return { jobs: rows.map(CronjobQueries.rowToDefinition) };
  }

  /**
   * Replace all jobs for a specific key with the contents of `file`.
   *
   * Deletes the existing rows for the key and re-inserts the supplied jobs.
   * The legacy implementation used the same delete-then-insert pattern; the
   * write is fast (cronjobs are small, low-cardinality) and skipping the
   * delta computation keeps this method as simple as possible.
   *
   * Wrapped in a Drizzle transaction so a crash or lock error between the
   * `delete` and the last `insert` doesn't leave the table in an
   * incomplete state (some jobs missing) — the legacy `cronjob-store.ts`
   * had the same gap; the migration is the appropriate moment to fix it.
   */
  saveFile(key: string, file: CronjobFile): void {
    const db = getDb();
    db.transaction((tx) => {
      tx.delete(cronjobs).where(eq(cronjobs.fileKey, key)).run();

      for (const job of file.jobs) {
        tx.insert(cronjobs)
          .values({
            id: job.id,
            fileKey: key,
            name: job.name,
            prompt: job.prompt,
            cronExpression: job.cronExpression,
            scope: job.scope,
            workspaceId: job.workspaceId ?? null,
            enabled: job.enabled,
            createdAt: job.createdAt,
            lastRunAt: job.lastRunAt ?? null,
            lastRunStatus: job.lastRunStatus ?? null,
          })
          .run();
      }
    });
  }

  /** List every cronjob across every key. */
  listAll(): (CronjobDefinition & { fileKey: string })[] {
    const db = getDb();
    const rows = db.select().from(cronjobs).all();
    return rows.map((row) => ({
      ...CronjobQueries.rowToDefinition(row),
      fileKey: row.fileKey,
    }));
  }

  /** Delete all jobs for a key (used during workspace/project removal). */
  deleteFile(key: string): void {
    const db = getDb();
    db.delete(cronjobs).where(eq(cronjobs.fileKey, key)).run();
  }

  /**
   * Stamp the last-run timestamp + status on a single job.
   *
   * Used by the scheduler's fire path to record outcome. Kept as a
   * dedicated method (rather than shoehorning through `saveFile`) so the
   * scheduler doesn't have to load + diff + replace the whole file on every
   * tick — fire-path latency matters because errors here are silently
   * swallowed and would mask cronjob execution bugs.
   */
  updateLastRun(jobId: string, status: "completed" | "failed" | "skipped"): void {
    const db = getDb();
    db.update(cronjobs)
      .set({ lastRunAt: new Date().toISOString(), lastRunStatus: status })
      .where(eq(cronjobs.id, jobId))
      .run();
  }

  /**
   * Convert a Drizzle row into the optional-T-shaped `CronjobDefinition`.
   *
   * Static so the service tier can map listAll-style results without
   * needing a queries instance handy.
   */
  static rowToDefinition(row: typeof cronjobs.$inferSelect): CronjobDefinition {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      cronExpression: row.cronExpression,
      scope: row.scope as CronjobDefinition["scope"],
      workspaceId: row.workspaceId ?? undefined,
      enabled: row.enabled,
      createdAt: row.createdAt,
      lastRunAt: row.lastRunAt ?? undefined,
      lastRunStatus: row.lastRunStatus as CronjobDefinition["lastRunStatus"],
    };
  }
}
