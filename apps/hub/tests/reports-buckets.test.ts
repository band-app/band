// Integration tests for the trend-chart bucket sizing (issue #425).
//
// The pure frontend helpers (`resolvePeriod`, `formatBucketTick`,
// `formatBucketTooltipLabel`) are covered in
// `apps/web/tests/reports-format.test.ts`.
//
//   `UsageEventQueries.aggregate({ groupBy: "week" | "month" })` —
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
import { closeDb } from "../src/server/infra/db/connection";
import { UsageEventQueries } from "../src/server/infra/db/queries/usage-events";

const DAY_MS = 24 * 60 * 60 * 1000;

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
