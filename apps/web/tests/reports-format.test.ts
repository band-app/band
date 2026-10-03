// Pure frontend helpers for the reports trend chart (issue #425):
// `resolvePeriod`, `formatBucketTick`, `formatBucketTooltipLabel`.
// Locale-independent shape assertions.
//
// The bucket-size SELECTION policy (<=60d -> day, <=365d -> week, > -> month)
// is tested through the public `reports.summary` HTTP endpoint in
// `apps/hub/tests/reports.test.ts`, and the SQL bucketing in
// `apps/hub/tests/reports-buckets.test.ts`.

import { describe, expect, it } from "vitest";
import {
  formatBucketTick,
  formatBucketTooltipLabel,
  resolvePeriod,
} from "../src/lib/format-report";

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
