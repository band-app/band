import {
  type AggregateRow,
  type GroupBy,
  UsageEventQueries,
} from "../infra/db/queries/usage-events";
import { getUsageScannerService } from "../infra/usage-scanner/usage-scanner";

/**
 * Time-bucket size for the trend-chart series (`byBucket`).
 *
 * Chosen server-side by `ReportsService.pickBucket` from the requested
 * range so a year-long query doesn't ship 365 daily rows that recharts
 * can't draw legibly in 224 px of height. The client reads `bucketSize`
 * off the response to format X-axis ticks and chart headings.
 */
export type BucketSize = Extract<GroupBy, "day" | "week" | "month">;

/**
 * Shape returned by `ReportsService.summary`. The API router types its
 * tRPC procedure against this so callers stay schema-stable when the
 * service grows new aggregates.
 */
export interface ReportsSummary {
  /** Echo of the range used so the client can label charts. */
  fromMs: number;
  toMs: number;
  /** Bucket size selected by `pickBucket(fromMs, toMs)`. The client
   *  uses this to label the chart heading and format the X-axis ticks
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

/**
 * Reports service (issue #425).
 *
 * Owns the aggregation logic and bucket-size policy for the Reports
 * dialog. The API router validates inputs and delegates here — per
 * Band's 3-tier rule, routers do not touch infra queries directly.
 *
 * Stateless aside from its injected `UsageEventQueries` dep; safe to
 * share across requests.
 */
export class ReportsService {
  constructor(private readonly usageEventQueries: UsageEventQueries = new UsageEventQueries()) {}

  /**
   * Choose the trend-chart bucket size from the requested range.
   *
   * Targets the 7–60-dot legibility band that recharts can render in
   * the dialog's chart area without smearing into a continuous wash or
   * starving the X-axis of tick labels:
   *
   *   range ≤ 60 days    → daily   (today / last7 / last30 → 1–30 dots)
   *   range ≤ 365 days   → weekly  (last90 → 13 / last365 → ~52)
   *   range > 365 days   → monthly (multi-year custom → 12+/year)
   *
   * The thresholds are deliberately matched to the presets in
   * `format-report.ts::PERIOD_OPTIONS` so each preset lands on exactly
   * one bucket size, and to the SQLite expressions in
   * `UsageEventQueries.aggregate` that emit the corresponding
   * YYYY-MM-DD bucket label.
   *
   * Static because it's a pure function of the input range — no DB
   * access — but lives on the service so the bucket-selection policy
   * has one home alongside the aggregation logic that consumes it.
   */
  static pickBucket(fromMs: number, toMs: number): BucketSize {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const days = (toMs - fromMs) / DAY_MS;
    if (days <= 60) return "day";
    if (days <= 365) return "week";
    return "month";
  }

  /**
   * Aggregate usage in the half-open range `[fromMs, toMs)`.
   *
   * Fires the disk scanner as a side effect so a future read picks up
   * fresh data, but does NOT block on it — the first tick after install
   * can take minutes on a populated workstation (Claude SDK session
   * parses + OpenCode subprocess spawns), and awaiting it would make
   * the dialog spin without progress. The user-visible flow:
   *
   *   1. Open Reports → instant render with whatever's currently in
   *      `usage_events`. Empty on a fresh install.
   *   2. Background scanner (started at boot, ticking every 5 min)
   *      keeps filling the table. The first tick covers the bulk of
   *      the backfill.
   *   3. User clicks the refresh button (or re-opens the dialog) to
   *      pick up the new rows.
   *
   * `tick()` deduplicates concurrent callers via an in-flight promise,
   * so this `void` call is a no-op when the periodic tick is already
   * running, and the polling-disabled setting short-circuits it
   * cheaply.
   */
  summary(fromMs: number, toMs: number): ReportsSummary {
    void getUsageScannerService()
      .tick()
      .catch(() => {
        // Already logged inside `tick()`.
      });

    // One row, `bucket = "total"`. We call `aggregate()` once without
    // groupBy rather than summing the byModel rows so a future addition
    // (e.g. tasks with neither model nor agent set) can't silently
    // diverge from the total.
    const totalRows = this.usageEventQueries.aggregate({ fromMs, toMs });
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

    const bucketSize = ReportsService.pickBucket(fromMs, toMs);

    return {
      fromMs,
      toMs,
      bucketSize,
      total,
      byModel: this.usageEventQueries.aggregate({ fromMs, toMs, groupBy: "model" }),
      byProject: this.usageEventQueries.aggregate({ fromMs, toMs, groupBy: "project" }),
      byAgent: this.usageEventQueries.aggregate({ fromMs, toMs, groupBy: "codingAgentId" }),
      byWorkspace: this.usageEventQueries.aggregate({ fromMs, toMs, groupBy: "workspaceId" }),
      byBucket: this.usageEventQueries.aggregate({ fromMs, toMs, groupBy: bucketSize }),
    };
  }
}

/**
 * Shared singleton consumed by the API tier (reports router). Stateless
 * apart from the injected queries dep — one instance is safe across
 * callers and centralises the place to update when stateful fields
 * (cache, in-memory invalidation) eventually land.
 */
export const reportsService = new ReportsService();
