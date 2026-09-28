import { createLogger } from "@band-app/logger";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { usageEvents as usageEventsTable } from "../schema";
import { SettingsQueries } from "./settings";

const log = createLogger("usage-event-queries");

/**
 * One row per coding-agent `UsageEvent` (per-turn tokens) plus one cost-only
 * row per successful `session-result` when the adapter reports
 * `costUsd > 0`. Token-only and cost-only rows have zeros in the columns
 * they don't carry — `SUM` over each column still produces the right total.
 *
 * Mirrors the `usage_events` table in `schema.ts` with optional fields
 * collapsed to `T | undefined` so the service tier can pass these around
 * without sprinkling `?? undefined` everywhere.
 */
export interface UsageEventRecord {
  /** Auto-incremented surrogate key. Omitted on insert. */
  id?: number;
  /** Band's task id when the row originated from a Band-driven session;
   *  empty string when the row was backfilled from disk by the Reports
   *  scanner (issue #425). */
  taskId: string;
  chatId?: string;
  workspaceId: string;
  /** Project name (e.g. "band"). Always present — empty string is fine for
   *  the rare case where the workspace can't be resolved. */
  project: string;
  sessionId?: string;
  codingAgentId?: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens: number;
  costUsd: number;
  capturedAt: number;
  /**
   * Dedup key — `${provider}:${sessionId}:${turnIndex}`. The scanner
   * sets this on every row; `INSERT OR IGNORE` makes re-scans idempotent.
   */
  externalKey?: string;
}

export type GroupBy =
  | "model"
  | "project"
  | "codingAgentId"
  | "workspaceId"
  | "day"
  | "week"
  | "month";

export interface AggregateFilters {
  fromMs: number;
  toMs: number;
  groupBy?: GroupBy;
}

/**
 * Per-group aggregated row. The `bucket` field is the group key
 * (model name, project name, agent id, workspace id, or YYYY-MM-DD day).
 * `null` is replaced with the string `"unknown"` so the UI renders a stable
 * label.
 */
export interface AggregateRow {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  /**
   * Distinct sessions contributing to this row. Sessions are the
   * provider-native unit (one chat thread per Claude/Codex/OpenCode
   * session id) — meaningful for both Band-driven turns and
   * scanner-backfilled CLI sessions. The earlier "taskCount" using
   * `task_id` was meaningless for disk-scanned rows because the
   * scanner writes them with an empty task_id (no Band task), so
   * COUNT DISTINCT would just count `""` as 1.
   */
  sessionCount: number;
}

/** Map of `GroupBy` → DB column name. SQL alias-stable so the same key
 *  feeds both the SELECT projection and the GROUP BY clause. Time-based
 *  buckets (`day`/`week`/`month`) are handled separately in `aggregate`
 *  because they need a `strftime`/`date` expression, not a raw column. */
const GROUP_BY_COLUMN: Record<Exclude<GroupBy, "day" | "week" | "month">, string> = {
  model: "model",
  project: "project",
  codingAgentId: "coding_agent_id",
  workspaceId: "workspace_id",
};

/**
 * Default retention window for usage-event rows when no
 * user-configured override is present.
 *
 * 1 year. The actual row volume is tiny (~10 MB for a heavy user at
 * one year of per-hour buckets, dwarfed by the source-of-truth JSONL
 * sessions the scanner reads from), so retention is dominated by
 * "how far back does the Reports dialog let me look" — for which a
 * year is the natural default. Users with extreme volumes can lower
 * it via settings (`usageRetentionDays` in `settings.json`).
 */
export const USAGE_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** How often the background sweep re-runs after the first pass on boot. */
export const USAGE_EVENT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Database-backed data access for the `usage_events` table (issue #425 —
 * Reports page).
 *
 * Infra tier — knows nothing about services or routers. The class is a thin
 * wrapper around Drizzle calls; the calling service layer (`task-service`)
 * handles capture as agent events stream in.
 */
export class UsageEventQueries {
  /** Insert a single usage-event row. */
  insert(event: UsageEventRecord): void {
    const db = getDb();
    db.insert(usageEventsTable)
      .values({
        taskId: event.taskId,
        chatId: event.chatId ?? null,
        workspaceId: event.workspaceId,
        project: event.project,
        sessionId: event.sessionId ?? null,
        codingAgentId: event.codingAgentId ?? null,
        provider: event.provider ?? null,
        model: event.model ?? null,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        costUsd: event.costUsd,
        capturedAt: event.capturedAt,
        externalKey: event.externalKey ?? null,
      })
      .run();
  }

  /**
   * Upsert one usage-event row by `external_key`. Used by the Reports
   * scanner: each tick the scanner re-reads any session whose file's
   * `lastModified` is past the watermark, re-groups its turns by
   * (hour, model), and writes one row per bucket. When a bucket
   * already exists (the session grew within the same hour), the new
   * totals **replace** the old ones — this is correct because the
   * scanner ALWAYS computes the bucket's full totals from the
   * provider's source-of-truth session file, never deltas.
   *
   * The `taskId`/`chatId`/`workspaceId`/etc. dimensions are left as
   * inserted on first write; only the volatile token + cost columns
   * are overwritten on conflict.
   *
   * Prefer `upsertBatch` when writing more than one bucket — it wraps
   * the inserts in a single SQLite transaction (one fsync instead of
   * one per row), which makes a meaningful difference on the first
   * boot when the scanner backfills hundreds of sessions.
   */
  upsert(event: UsageEventRecord): void {
    this.upsertBatch([event]);
  }

  /**
   * Upsert multiple rows in a single SQLite transaction. Same
   * semantics as `upsert` per row (replace on `external_key` conflict)
   * but batches the writes so a 5-bucket session costs one fsync
   * instead of five.
   *
   * Empty arrays are a no-op (skips the transaction overhead entirely).
   */
  upsertBatch(events: UsageEventRecord[]): void {
    if (events.length === 0) return;
    const db = getDb();
    db.transaction((tx) => {
      for (const event of events) {
        tx.insert(usageEventsTable)
          .values({
            taskId: event.taskId,
            chatId: event.chatId ?? null,
            workspaceId: event.workspaceId,
            project: event.project,
            sessionId: event.sessionId ?? null,
            codingAgentId: event.codingAgentId ?? null,
            provider: event.provider ?? null,
            model: event.model ?? null,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            reasoningOutputTokens: event.reasoningOutputTokens,
            costUsd: event.costUsd,
            capturedAt: event.capturedAt,
            externalKey: event.externalKey ?? null,
          })
          .onConflictDoUpdate({
            target: usageEventsTable.externalKey,
            set: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheCreationTokens: event.cacheCreationTokens,
              reasoningOutputTokens: event.reasoningOutputTokens,
              costUsd: event.costUsd,
            },
          })
          .run();
      }
    });
  }

  /**
   * Aggregate usage in the range `[fromMs, toMs)` (half-open so consecutive
   * period queries don't double-count the boundary). Returns one row per
   * group bucket; without `groupBy`, returns exactly one row with
   * `bucket = "total"`.
   *
   * The "day" bucket is computed in the user's **local** timezone via
   * SQLite's `strftime('%Y-%m-%d', captured_at / 1000, 'unixepoch',
   * 'localtime')`. Band is a single-user local app, so the local TZ on the
   * server matches what the user sees — no per-request TZ override needed.
   */
  aggregate(filters: AggregateFilters): AggregateRow[] {
    const db = getDb();

    // Half-open range. We use a raw fragment for the bucket expression so
    // the same code path handles the no-groupBy "total" case and the
    // grouped cases without a second query builder.
    //
    // Time buckets all emit a YYYY-MM-DD label (so the client can
    // `Date.parse()` it without a special parser) anchored to the start
    // of the bucket in the **server's local timezone** — matches Band's
    // single-user-local-app assumption:
    //   • day   → strftime('%Y-%m-%d', …)                  → "2026-03-15"
    //   • week  → date(…, '-6 days', 'weekday 1')          → "2026-03-09"
    //                Monday of the ISO week containing the captured day.
    //                The "-6 days, weekday 1" hop handles every weekday:
    //                going back 6 days then forward to the next Monday
    //                lands on the Monday at-or-before the input date.
    //   • month → strftime('%Y-%m-01', …)                  → "2026-03-01"
    const bucketExpr =
      filters.groupBy === "day"
        ? sql`strftime('%Y-%m-%d', ${usageEventsTable.capturedAt} / 1000, 'unixepoch', 'localtime')`
        : filters.groupBy === "week"
          ? sql`date(${usageEventsTable.capturedAt} / 1000, 'unixepoch', 'localtime', '-6 days', 'weekday 1')`
          : filters.groupBy === "month"
            ? sql`strftime('%Y-%m-01', ${usageEventsTable.capturedAt} / 1000, 'unixepoch', 'localtime')`
            : filters.groupBy
              ? sql.raw(GROUP_BY_COLUMN[filters.groupBy])
              : sql`'total'`;

    const rows = db
      .select({
        bucket: sql<string | null>`${bucketExpr}`.as("bucket"),
        inputTokens: sql<number>`COALESCE(SUM(${usageEventsTable.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${usageEventsTable.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${usageEventsTable.cacheReadTokens}), 0)`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${usageEventsTable.cacheCreationTokens}), 0)`,
        reasoningOutputTokens: sql<number>`COALESCE(SUM(${usageEventsTable.reasoningOutputTokens}), 0)`,
        costUsd: sql<number>`COALESCE(SUM(${usageEventsTable.costUsd}), 0)`,
        sessionCount: sql<number>`COUNT(DISTINCT ${usageEventsTable.sessionId})`,
      })
      .from(usageEventsTable)
      .where(
        and(
          gte(usageEventsTable.capturedAt, filters.fromMs),
          lt(usageEventsTable.capturedAt, filters.toMs),
        ),
      )
      .groupBy(sql`bucket`)
      .orderBy(sql`bucket`)
      .all();

    return rows.map((r) => {
      const totalTokens =
        Number(r.inputTokens) +
        Number(r.outputTokens) +
        Number(r.cacheReadTokens) +
        Number(r.cacheCreationTokens) +
        Number(r.reasoningOutputTokens);
      return {
        // SQLite SUM over NULL/no-rows is COALESCE'd above; bucket may be
        // NULL when grouping by a nullable column (model/codingAgentId)
        // and the underlying row left the field unset. Surface those as
        // "unknown" so the UI has a stable label.
        bucket: r.bucket ?? "unknown",
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        cacheReadTokens: Number(r.cacheReadTokens),
        cacheCreationTokens: Number(r.cacheCreationTokens),
        reasoningOutputTokens: Number(r.reasoningOutputTokens),
        totalTokens,
        costUsd: Number(r.costUsd),
        sessionCount: Number(r.sessionCount),
      };
    });
  }

  /**
   * Delete usage events belonging to a workspace. Called when a workspace is
   * removed, alongside `TaskQueries.deleteWorkspaceTasks`.
   *
   * Returns the number of rows deleted.
   */
  deleteWorkspaceEvents(workspaceId: string): number {
    const db = getDb();
    const result = db
      .delete(usageEventsTable)
      .where(eq(usageEventsTable.workspaceId, workspaceId))
      .run();
    return Number(result.changes ?? 0);
  }

  /**
   * Delete events older than `cutoffMs` (measured against `captured_at`).
   *
   * Unlike `tasks` there's no `completedAt`/`startedAt` split — usage rows
   * always have a `capturedAt` timestamp from the stream, so a single
   * predicate handles both shapes. The `isNotNull` guard is technically
   * redundant (column is `NOT NULL`) but matches the `TaskQueries` style
   * so a future schema change can't silently break the prune.
   */
  deleteOlderThan(cutoffMs: number): number {
    const db = getDb();
    const result = db
      .delete(usageEventsTable)
      .where(and(isNotNull(usageEventsTable.capturedAt), lt(usageEventsTable.capturedAt, cutoffMs)))
      .run();
    return Number(result.changes ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Periodic prune scheduler — mirrors the `tasks` prune in
// `queries/tasks.ts`. Same module-level singleton pattern so HMR /
// module re-evaluation can't double-schedule the timer.
// ---------------------------------------------------------------------------

const PRUNE_SCHEDULER_KEY = Symbol.for("band.usage-event-prune-scheduler");
const pruneG = globalThis as unknown as Record<symbol, unknown>;

interface PruneSchedulerState {
  timer: NodeJS.Timeout | null;
}

if (!pruneG[PRUNE_SCHEDULER_KEY]) {
  pruneG[PRUNE_SCHEDULER_KEY] = { timer: null } satisfies PruneSchedulerState;
}

const pruneState = pruneG[PRUNE_SCHEDULER_KEY] as PruneSchedulerState;

/**
 * Resolve the effective retention window in milliseconds.
 *
 * Reads `usageRetentionDays` from on-disk settings and converts to ms;
 * falls back to `USAGE_EVENT_RETENTION_MS` (1 year) when the field is
 * unset, malformed, or outside the bounded range enforced by the
 * settings Zod schema. The settings file is re-read on every prune so
 * a user-edited value takes effect on the next sweep (≤24h) without
 * a server restart.
 */
function resolveRetentionMs(): number {
  try {
    const days = new SettingsQueries().load().usageRetentionDays;
    if (typeof days === "number" && Number.isFinite(days) && days >= 1 && days <= 3650) {
      return days * 24 * 60 * 60 * 1000;
    }
  } catch {
    // Fall through to default — never let a malformed settings file
    // block the prune sweep.
  }
  return USAGE_EVENT_RETENTION_MS;
}

/**
 * Run a single prune pass.
 *
 * When `retentionMs` is omitted, the effective retention is read from
 * settings (`usageRetentionDays`), falling back to
 * `USAGE_EVENT_RETENTION_MS` (1 year). Tests and the boot path pass
 * an explicit value when they want a deterministic window.
 *
 * Exposed as its own export so tests (and the boot path) can trigger a
 * deterministic sweep without standing up the interval timer.
 */
export function pruneOldUsageEvents(retentionMs?: number): number {
  const effectiveMs = retentionMs ?? resolveRetentionMs();
  const cutoff = Date.now() - effectiveMs;
  const count = new UsageEventQueries().deleteOlderThan(cutoff);
  if (count > 0) {
    log.info(
      { count, retentionMs: effectiveMs },
      "pruned usage events older than retention window",
    );
  }
  return count;
}

/**
 * Start the background prune sweep.
 *
 * Runs one pass immediately, then re-runs every `intervalMs` (default 24h).
 * Idempotent: a second call is a no-op while the previous timer is still
 * active. The timer is `unref()`'d so it doesn't keep the event loop alive
 * during shutdown.
 */
export function startUsageEventPruneScheduler(
  options: { retentionMs?: number; intervalMs?: number } = {},
): void {
  if (pruneState.timer) return;

  // Pass `retentionMs` through verbatim when set so tests can pin a
  // deterministic window. When unset, `pruneOldUsageEvents` re-reads
  // settings each pass so an in-flight user edit to
  // `usageRetentionDays` takes effect on the next 24h sweep.
  const intervalMs = options.intervalMs ?? USAGE_EVENT_PRUNE_INTERVAL_MS;

  // Log-and-continue: a DB lock or corruption at boot time must not crash
  // `main()` before the server binds its port. The interval handler below
  // applies the same policy.
  try {
    pruneOldUsageEvents(options.retentionMs);
  } catch (err) {
    log.error({ err }, "initial usage-event prune on boot failed");
  }

  const timer = setInterval(() => {
    try {
      pruneOldUsageEvents(options.retentionMs);
    } catch (err) {
      log.error({ err }, "scheduled usage-event prune failed");
    }
  }, intervalMs);
  timer.unref();
  pruneState.timer = timer;
}

/** Stop the background prune sweep. Used on graceful shutdown and in tests. */
export function stopUsageEventPruneScheduler(): void {
  if (pruneState.timer) {
    clearInterval(pruneState.timer);
    pruneState.timer = null;
  }
}
