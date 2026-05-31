// Integration tests for the trend-chart bucket sizing (issue #425).
//
// Three halves:
//
//   1. Pure frontend helpers — `resolvePeriod`, `formatBucketTick`,
//      `formatBucketTooltipLabel`. Locale-independent shape assertions.
//
//   2. `UsageEventQueries.aggregate({ groupBy: "week" | "month" })` —
//      real SQLite, real production schema (the infra-tier public
//      surface, same shape as `usage-events-retention.test.ts`). Seeds
//      rows that straddle a week boundary and a month boundary and
//      asserts the bucketed results collapse into the expected counts.
//      SQLite's `'localtime'` modifier means the bucket math runs in
//      the server's local TZ; the test seeds times relative to local
//      midnight to stay deterministic across CI regions.
//
// The bucket-size SELECTION policy (≤60d → day, ≤365d → week, > → month)
// is tested through the public `reports.summary` HTTP endpoint in
// `reports.test.ts` rather than by importing `ReportsService.pickBucket`
// directly — keeps the black-box rule intact for any API-tier code.
//
// Same in-process pattern as `usage-events-retention.test.ts`: tmp
// BAND_HOME per test, `closeDb()` between tests.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatBucketTick,
  formatBucketTooltipLabel,
  resolvePeriod,
} from "../src/lib/format-report";
import { closeDb } from "../src/server/infra/db/connection";
import { UsageEventQueries } from "../src/server/infra/db/queries/usage-events";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// resolvePeriod — preset → range conversion
// ---------------------------------------------------------------------------

describe("resolvePeriod — new presets", () => {
  // Snap to start-of-day on the host so the assertions are TZ-agnostic.
  // Use the SAME `setDate(getDate() - n)` arithmetic that `resolvePeriod`
  // uses internally — naive `now - n * DAY_MS` math is off by an hour
  // when a DST transition falls inside the range.
  function localMidnightDaysAgo(daysAgo: number): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  }
  const localMidnight = localMidnightDaysAgo(0);

  it("last90 spans 89 prior days + today (90 day boundaries)", () => {
    const { fromMs, toMs } = resolvePeriod("last90");
    expect(fromMs).toBe(localMidnightDaysAgo(89));
    // toMs is `Date.now()` snap; we don't pin to the exact ms but do
    // assert it's at-or-after this run's `localMidnight` (today). The
    // range width crosses the 60-day day/week threshold — the
    // resulting bucket-size selection is asserted via HTTP in
    // `reports.test.ts`.
    expect(toMs).toBeGreaterThanOrEqual(localMidnight);
    expect((toMs - fromMs) / DAY_MS).toBeGreaterThan(60);
  });

  it("last365 spans 364 prior days + today", () => {
    const { fromMs, toMs } = resolvePeriod("last365");
    expect(fromMs).toBe(localMidnightDaysAgo(364));
    // Range width is between the 60-day and 365-day thresholds.
    expect((toMs - fromMs) / DAY_MS).toBeGreaterThan(60);
    expect((toMs - fromMs) / DAY_MS).toBeLessThanOrEqual(365);
  });

  it("last30 produces a range under the 60-day day/week boundary", () => {
    const { fromMs, toMs } = resolvePeriod("last30");
    expect((toMs - fromMs) / DAY_MS).toBeLessThanOrEqual(60);
  });

  it("custom > 365 days exceeds the week/month boundary", () => {
    // Two years back via `setDate` so the from-date doesn't drift past
    // a leap-day or DST boundary the way `localMidnight - N * DAY_MS`
    // does. ISO date strings (YYYY-MM-DD) are what the custom-range
    // <input type="date"> would emit.
    const from = new Date(localMidnightDaysAgo(2 * 365));
    const fromIso = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
    const to = new Date(localMidnight);
    const toIso = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}-${String(to.getDate()).padStart(2, "0")}`;
    const { fromMs, toMs } = resolvePeriod("custom", fromIso, toIso);
    expect((toMs - fromMs) / DAY_MS).toBeGreaterThan(365);
  });
});

// ---------------------------------------------------------------------------
// formatBucketTick / formatBucketTooltipLabel — locale-aware but the
// shape (length, contains digits) is stable enough to assert on.
// ---------------------------------------------------------------------------

describe("formatBucketTick", () => {
  // 2026-03-15T00:00:00 LOCAL — picked to test the day/month branches.
  const epoch = new Date(2026, 2, 15).getTime();

  it("day → short month + day", () => {
    const tick = formatBucketTick(epoch, "day");
    // Locale-dependent but always contains a month abbreviation + a number.
    expect(tick).toMatch(/\w/);
    expect(tick).toMatch(/\d/);
  });

  it("month → short month + 2-digit year (so multi-year views don't repeat month names)", () => {
    const tick = formatBucketTick(epoch, "month");
    expect(tick).toMatch(/26/);
  });

  it("returns empty string for non-finite epochs (recharts initial layout)", () => {
    expect(formatBucketTick(Number.NaN, "day")).toBe("");
    expect(formatBucketTick(Number.POSITIVE_INFINITY, "month")).toBe("");
  });
});

describe("formatBucketTooltipLabel", () => {
  const epoch = new Date(2026, 2, 15).getTime();

  it("week → 'Week of …' prefix", () => {
    expect(formatBucketTooltipLabel(epoch, "week")).toMatch(/^Week of /);
  });

  it("day → weekday + month + day + year", () => {
    // Locale-dependent but always 4-digit year present.
    expect(formatBucketTooltipLabel(epoch, "day")).toMatch(/2026/);
  });
});

// ---------------------------------------------------------------------------
// aggregate({ groupBy: "week" | "month" }) — real SQLite
// ---------------------------------------------------------------------------

describe("UsageEventQueries.aggregate — week & month buckets", () => {
  let tmp: string;
  let originalBandHome: string | undefined;
  let queries: UsageEventQueries;

  // 2026-03-15 local midnight — anchor for the bucket-boundary tests.
  // 2026-03-15 is a Sunday. The Monday of its ISO week is 2026-03-09.
  // SQLite expression `date(..., '-6 days', 'weekday 1')` returns
  // "2026-03-09" for any captured_at on Mon Mar 9 through Sun Mar 15.
  const wkStart = new Date(2026, 2, 9).getTime(); // Monday
  const wkEnd = new Date(2026, 2, 15).getTime(); // Sunday
  const nextMonday = new Date(2026, 2, 16).getTime();

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-reports-buckets-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
    queries = new UsageEventQueries();
  });

  afterEach(() => {
    closeDb();
    if (originalBandHome !== undefined) {
      process.env.BAND_HOME = originalBandHome;
    } else {
      delete process.env.BAND_HOME;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed(capturedAt: number, tokens: number, cost: number, sessionId: string): void {
    queries.insert({
      taskId: "",
      workspaceId: "w",
      project: "p",
      sessionId,
      provider: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningOutputTokens: 0,
      costUsd: cost,
      capturedAt,
    });
  }

  it("collapses every day Mon–Sun into one week bucket keyed on Monday", () => {
    seed(wkStart, 100, 0.01, "s1"); // Monday
    seed(wkStart + 2 * DAY_MS, 200, 0.02, "s2"); // Wednesday
    seed(wkStart + 5 * DAY_MS, 50, 0.005, "s3"); // Saturday
    seed(wkEnd, 25, 0.0025, "s4"); // Sunday — still same week
    seed(nextMonday, 999, 0.99, "s5"); // Monday — new week

    const rows = queries.aggregate({
      fromMs: wkStart,
      toMs: nextMonday + DAY_MS,
      groupBy: "week",
    });

    // Two distinct week buckets. The order is whatever SQLite picks
    // for the bucket string ASC; we look them up by key instead of
    // index for clarity.
    expect(rows).toHaveLength(2);
    const byKey = new Map(rows.map((r) => [r.bucket, r]));
    expect(byKey.has("2026-03-09")).toBe(true);
    expect(byKey.has("2026-03-16")).toBe(true);
    // 4 sessions in the Mar 09 week (s1+s2+s3+s4), 1 in the Mar 16 week.
    expect(byKey.get("2026-03-09")!.sessionCount).toBe(4);
    expect(byKey.get("2026-03-09")!.inputTokens).toBe(375);
    expect(byKey.get("2026-03-09")!.costUsd).toBeCloseTo(0.0375, 4);
    expect(byKey.get("2026-03-16")!.sessionCount).toBe(1);
    expect(byKey.get("2026-03-16")!.inputTokens).toBe(999);
  });

  it("collapses every day within a calendar month into one month bucket", () => {
    seed(new Date(2026, 1, 1).getTime(), 10, 0.001, "s_feb_a"); // Feb 1
    seed(new Date(2026, 1, 15).getTime(), 20, 0.002, "s_feb_b"); // Feb 15
    seed(new Date(2026, 1, 28).getTime(), 30, 0.003, "s_feb_c"); // Feb 28
    seed(new Date(2026, 2, 1).getTime(), 100, 0.01, "s_mar_a"); // Mar 1
    seed(new Date(2026, 2, 31).getTime(), 200, 0.02, "s_mar_b"); // Mar 31

    const rows = queries.aggregate({
      fromMs: new Date(2026, 1, 1).getTime(),
      toMs: new Date(2026, 3, 1).getTime(),
      groupBy: "month",
    });

    expect(rows).toHaveLength(2);
    const byKey = new Map(rows.map((r) => [r.bucket, r]));
    expect(byKey.has("2026-02-01")).toBe(true);
    expect(byKey.has("2026-03-01")).toBe(true);
    expect(byKey.get("2026-02-01")!.inputTokens).toBe(60);
    expect(byKey.get("2026-03-01")!.inputTokens).toBe(300);
  });

  it("returns YYYY-MM-DD bucket strings that round-trip through Date.parse", () => {
    // The chart's numeric X-axis relies on `Date.parse(`${bucket}T00:00:00`)`
    // landing on the bucket start. Validates every time bucket emits a
    // string that parses cleanly to a finite epoch-ms.
    seed(wkStart, 1, 0, "s1");
    seed(new Date(2026, 1, 15).getTime(), 1, 0, "s2");

    const dayRows = queries.aggregate({
      fromMs: wkStart - 30 * DAY_MS,
      toMs: nextMonday + 30 * DAY_MS,
      groupBy: "day",
    });
    const weekRows = queries.aggregate({
      fromMs: wkStart - 30 * DAY_MS,
      toMs: nextMonday + 30 * DAY_MS,
      groupBy: "week",
    });
    const monthRows = queries.aggregate({
      fromMs: wkStart - 60 * DAY_MS,
      toMs: nextMonday + 30 * DAY_MS,
      groupBy: "month",
    });

    for (const r of [...dayRows, ...weekRows, ...monthRows]) {
      const parsed = Date.parse(`${r.bucket}T00:00:00`);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThan(0);
    }
  });
});
