/**
 * Number-formatting helpers used by the Reports dialog (issue #425).
 *
 * Kept in their own module so the Reports dialog has stable, testable
 * helpers without competing with the rest of the app for a "format.ts"
 * namespace. If other surfaces start needing the same `formatUsd` /
 * `formatTokens` shape later, promote them to a shared `lib/format.ts`.
 *
 * **Tradeoff: `Intl.NumberFormat` instances are recreated on each call.**
 * The constructors are not free (\~50 µs each), but the Reports dialog
 * formats <100 numbers per render and re-renders on user interaction.
 * Caching the formatters in module-level constants would complicate
 * locale-change handling for a saving the user will never notice.
 */

/**
 * Format a USD amount using the browser's locale.
 *
 *   - `< $0.01` falls back to four-decimal precision so per-task costs
 *     like $0.0042 don't collapse to "$0.00" and look free.
 *   - Otherwise two decimals (standard currency display).
 *   - `NaN` / non-finite values render as the literal "—" so a missing
 *     row in the breakdown table is visually distinct from a $0 row.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  const maximumFractionDigits = Math.abs(value) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(value);
}

/**
 * Format a token count using compact notation (1.2K, 4.5M) so the cards
 * and table cells fit in narrow columns. Non-finite values render as
 * "—" to match `formatUsd`.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Format a percentage to one decimal place. Used by the share-of-cost
 * column in the breakdown tables.
 */
export function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return "—";
  }
  const pct = (numerator / denominator) * 100;
  return `${pct.toFixed(1)}%`;
}

/** Period key used by the Reports dialog header. */
export type PeriodKey = "today" | "last7" | "last30" | "last90" | "last365" | "custom";

/**
 * Resolve a period key to a half-open `[fromMs, toMs)` range.
 *
 * Day boundaries use the user's local timezone — `new Date().setHours(0,…)`
 * snaps to local midnight, matching the SQLite `'localtime'` modifier
 * used by `UsageEventQueries.aggregate` when grouping by day.
 *
 *   - "today"   — local midnight → now.
 *   - "last7"   — local midnight 6 days ago → now (today + 6 prior days = 7 buckets).
 *   - "last30"  — local midnight 29 days ago → now.
 *   - "last90"  — local midnight 89 days ago → now.
 *   - "last365" — local midnight 364 days ago → now (matches the default
 *                 1-year usage-events retention).
 *   - "custom"  — `customFrom` (local midnight) → `customTo + 24h` (exclusive
 *                 end of day).
 *
 * The longer presets line up with the server's bucket-size thresholds
 * in `pickBucket` so every preset lands at exactly one bucket size:
 *   last30 → daily (30 dots), last90 → weekly (~13 dots),
 *   last365 → weekly (~52 dots). A "custom" range >365 days falls into
 *   monthly buckets.
 */
export function resolvePeriod(
  period: PeriodKey,
  customFrom?: string,
  customTo?: string,
): { fromMs: number; toMs: number } {
  const now = Date.now();
  if (period === "custom") {
    const from = customFrom ? Date.parse(`${customFrom}T00:00:00`) : Number.NaN;
    const to = customTo ? Date.parse(`${customTo}T00:00:00`) + 24 * 60 * 60 * 1000 : Number.NaN;
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      return { fromMs: from, toMs: to };
    }
    // Fall through to today on bad custom input — the picker UI keeps
    // the user from submitting an invalid range, but this guards a
    // race where the inputs are still being typed.
    period = "today";
  }
  const daysBack =
    period === "today"
      ? 0
      : period === "last7"
        ? 6
        : period === "last30"
          ? 29
          : period === "last90"
            ? 89
            : period === "last365"
              ? 364
              : 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysBack);
  return { fromMs: start.getTime(), toMs: now };
}

/**
 * Format an epoch-ms tick label for the trend chart X-axis. The chart
 * uses a numeric X-axis (`type="number"`) so ticks land in proportional
 * time positions regardless of activity gaps, and `tickFormatter` here
 * decides the label shape:
 *
 *   day   → "Mar 15"        — short month + day for ≤60-day views
 *   week  → "Mar 15"        — Monday of the bucket week
 *   month → "Mar 26"        — short month + 2-digit year so a multi-year
 *                             view doesn't repeat "Mar" each year.
 *
 * Falls back to a plain ISO date when the value isn't a finite epoch-ms
 * (recharts occasionally feeds NaN during initial layout).
 */
export function formatBucketTick(epochMs: number, bucketSize: "day" | "week" | "month"): string {
  if (!Number.isFinite(epochMs)) return "";
  const d = new Date(epochMs);
  if (bucketSize === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Format a tooltip label for the trend chart — more verbose than the
 * axis tick because the tooltip has room for it:
 *
 *   day   → "Mon, Mar 15, 2026"
 *   week  → "Week of Mar 15, 2026"
 *   month → "Mar 2026"
 */
export function formatBucketTooltipLabel(
  epochMs: number,
  bucketSize: "day" | "week" | "month",
): string {
  if (!Number.isFinite(epochMs)) return "";
  const d = new Date(epochMs);
  if (bucketSize === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  if (bucketSize === "week") {
    return `Week of ${d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}`;
  }
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
