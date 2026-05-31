import { z } from "zod";
import {
  type AggregateRow,
  type GroupBy,
  UsageEventQueries,
} from "../../infra/db/queries/usage-events";
import { getUsageScannerService } from "../../services/usage-scanner-service";
import { publicProcedure, t } from "../trpc";

/**
 * Reports sub-router (issue #425).
 *
 * Aggregates the `usage_events` table over a half-open time range
 * `[fromMs, toMs)` and groups by total / model / project / coding agent /
 * workspace / day. Designed as one query so the dialog can render every
 * panel from a single network round-trip — recharts re-renders are cheap
 * but cold-loading 6 queries serially over the wire is not.
 *
 * Lives behind `publicProcedure` to match the rest of the router surface:
 * Band runs as a single-user local app today and authentication is handled
 * at the transport layer (tunnel token, localhost binding) rather than per
 * procedure.
 */
/**
 * Time-bucket size for the trend-chart series (`byBucket`).
 *
 * `pickBucket` chooses this server-side from the requested range so a
 * year-long query doesn't ship 365 daily rows that recharts can't draw
 * legibly in 224 px of height. The client just reads `bucketSize` off
 * the response to format X-axis ticks and headings.
 */
export type BucketSize = Extract<GroupBy, "day" | "week" | "month">;

/**
 * Choose the trend-chart bucket size from the requested range.
 *
 * Targets the 7–60-dot legibility band that recharts can render in the
 * dialog's chart area without smearing into a continuous wash or
 * starving the x-axis of tick labels:
 *
 *   range ≤ 60 days    → daily   (today / last7 / last30 → 1–30 dots)
 *   range ≤ 365 days   → weekly  (last90 → 13 / last365 → ~52)
 *   range > 365 days   → monthly (multi-year custom → 12+/year)
 *
 * The thresholds are deliberately matched to the presets exposed in
 * `format-report.ts::PERIOD_OPTIONS` so each preset lands on exactly
 * one bucket size, and to the SQLite expressions in
 * `UsageEventQueries.aggregate` that emit the corresponding YYYY-MM-DD
 * bucket label.
 *
 * Exported for the integration tests in `reports.test.ts`.
 */
export function pickBucket(fromMs: number, toMs: number): BucketSize {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const days = (toMs - fromMs) / DAY_MS;
  if (days <= 60) return "day";
  if (days <= 365) return "week";
  return "month";
}

export interface ReportsSummary {
  /** Echo of the range used so the client can label charts. */
  fromMs: number;
  toMs: number;
  /** Bucket size selected by `pickBucket(fromMs, toMs)`. The client uses
   *  this to label the chart heading and format the X-axis ticks
   *  (day → "Mar 15", week → "Mar 15", month → "Mar 26"). */
  bucketSize: BucketSize;
  /** Exactly one row with `bucket = "total"`. */
  total: AggregateRow;
  byModel: AggregateRow[];
  byProject: AggregateRow[];
  byAgent: AggregateRow[];
  byWorkspace: AggregateRow[];
  /** Trend series — one row per time bucket whose size is
   *  `bucketSize`. Each row's `bucket` is a YYYY-MM-DD string the
   *  client can `Date.parse(...)` to position on a numeric X-axis. */
  byBucket: AggregateRow[];
}

const usageEventQueries = new UsageEventQueries();

export const reportsRouter = t.router({
  /**
   * Aggregate usage in the half-open range `[fromMs, toMs)`.
   *
   * `fromMs` and `toMs` are epoch milliseconds. The "day" bucket inside
   * `byDay` is rendered in the server's local timezone — Band is a
   * single-user local app so the server and client always share a TZ; no
   * per-request override is wired through.
   */
  summary: publicProcedure
    .input(
      z.object({
        fromMs: z.number().int().nonnegative(),
        toMs: z.number().int().positive(),
      }),
    )
    .query(({ input }): ReportsSummary => {
      const { fromMs, toMs } = input;

      // Fire-and-forget: kick the scanner so the next read sees fresh
      // data, but don't block this read on it. The first tick after
      // install can take 2+ minutes on a populated dev workstation
      // (Claude SDK session parses + OpenCode subprocess spawns), and
      // awaiting it makes the dialog spin without any indication of
      // progress.
      //
      // The user-visible flow becomes:
      //   1. Open Reports → instant render with whatever's currently
      //      in `usage_events`. Empty on a fresh install.
      //   2. Background scanner (started at boot, ticking every 30 s)
      //      keeps filling the table. The first tick covers the bulk
      //      of the backfill.
      //   3. User clicks the refresh button (or re-opens the dialog)
      //      to pick up the new rows.
      //
      // `tick()` deduplicates concurrent callers via an in-flight
      // promise, so this `void` call is a no-op when the periodic tick
      // is already running.
      void getUsageScannerService()
        .tick()
        .catch(() => {
          // Already logged inside `tick()`.
        });

      // One row, `bucket = "total"`. We call `aggregate()` once without
      // groupBy rather than summing the byModel rows so a future addition
      // (e.g. tasks with neither model nor agent set) can't silently
      // diverge from the total.
      const totalRows = usageEventQueries.aggregate({ fromMs, toMs });
      const total: AggregateRow = totalRows[0] ?? {
        bucket: "total",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        sessionCount: 0,
      };

      const bucketSize = pickBucket(fromMs, toMs);

      return {
        fromMs,
        toMs,
        bucketSize,
        total,
        byModel: usageEventQueries.aggregate({ fromMs, toMs, groupBy: "model" }),
        byProject: usageEventQueries.aggregate({ fromMs, toMs, groupBy: "project" }),
        byAgent: usageEventQueries.aggregate({ fromMs, toMs, groupBy: "codingAgentId" }),
        byWorkspace: usageEventQueries.aggregate({ fromMs, toMs, groupBy: "workspaceId" }),
        byBucket: usageEventQueries.aggregate({ fromMs, toMs, groupBy: bucketSize }),
      };
    }),
});

export type ReportsRouter = typeof reportsRouter;
