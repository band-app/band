import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@band-app/ui";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatBucketTick,
  formatBucketTooltipLabel,
  formatPercent,
  formatTokens,
  formatUsd,
  type PeriodKey,
  resolvePeriod,
} from "../lib/format-report";
import { trpc } from "../lib/trpc-client";

/**
 * Reports dialog content (issue #425).
 *
 * Same content-shape as `TasksPageContent` / `CronjobsPageContent` /
 * `ResourcesPage`: a sticky header with filters + a scrollable body. The
 * outer `<Dialog>` shell lives in `ToolbarButtons.tsx`.
 *
 * Data model: a single `trpc.reports.summary` round-trip returns total +
 * five group-by aggregates. recharts renders the daily cost chart from the
 * `byDay` series. Cards and breakdown tables read straight from the
 * `AggregateRow` shape — no client-side reshuffling.
 */

interface AggregateRow {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  sessionCount: number;
}

type BucketSize = "day" | "week" | "month";

interface ReportsSummary {
  fromMs: number;
  toMs: number;
  bucketSize: BucketSize;
  total: AggregateRow;
  byModel: AggregateRow[];
  byProject: AggregateRow[];
  byAgent: AggregateRow[];
  byWorkspace: AggregateRow[];
  byBucket: AggregateRow[];
}

const PERIOD_OPTIONS: Array<{ value: PeriodKey; label: string }> = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "last90", label: "Last 90 days" },
  { value: "last365", label: "Last year" },
  { value: "custom", label: "Custom range" },
];

/** Human-readable heading + Y-axis label hint per bucket size. */
const BUCKET_HEADING: Record<BucketSize, string> = {
  day: "Daily cost",
  week: "Weekly cost",
  month: "Monthly cost",
};

export function ReportsPageContent() {
  const [period, setPeriod] = useState<PeriodKey>("last7");
  // ISO date strings (YYYY-MM-DD) so the native date picker can bind
  // directly. Empty string until the user opens the custom panel.
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [summary, setSummary] = useState<ReportsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve the range eagerly so the fetch / display effects key off a
  // pair of numbers (stable React deps) rather than the picker state.
  const range = useMemo(
    () => resolvePeriod(period, customFrom, customTo),
    [period, customFrom, customTo],
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await trpc.reports.summary.query({
        fromMs: range.fromMs,
        toMs: range.toMs,
      });
      setSummary(data as ReportsSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, [range.fromMs, range.toMs]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Derived: top model label for the "Top model" stat card. Picks the
  // single model with the highest cost, falling back to highest tokens
  // when every row has costUsd=0 (e.g. Codex/Gemini-only history).
  const topModel = useMemo(() => {
    if (!summary) return null;
    const rows = summary.byModel;
    if (rows.length === 0) return null;
    const byCost = [...rows].sort((a, b) => b.costUsd - a.costUsd);
    if (byCost[0].costUsd > 0) return byCost[0];
    return [...rows].sort((a, b) => b.totalTokens - a.totalTokens)[0];
  }, [summary]);

  const totalCost = summary?.total.costUsd ?? 0;
  const totalTokens = summary?.total.totalTokens ?? 0;
  const sessionCount = summary?.total.sessionCount ?? 0;

  return (
    // `min-w-0` is critical inside the Dialog: without it the table contents
    // below can force the flex container wider than the viewport, pushing the
    // dialog close-button off-screen on mobile (issue #425 follow-up).
    <div className="flex min-w-0 flex-col overflow-hidden" data-testid="reports__root">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-4 py-2">
        <Select value={period} onValueChange={(v) => setPeriod(v as PeriodKey)}>
          <SelectTrigger className="h-8 w-40 text-xs" data-testid="reports__period-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {period === "custom" && (
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground" htmlFor="reports-from">
              From
            </Label>
            <Input
              id="reports-from"
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 w-36 text-xs"
              data-testid="reports__custom-from"
            />
            <Label className="text-xs text-muted-foreground" htmlFor="reports-to">
              To
            </Label>
            <Input
              id="reports-to"
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 w-36 text-xs"
              data-testid="reports__custom-to"
            />
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={fetchData}
            aria-label="Refresh reports"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="reports__refresh"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {loading && !summary && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="px-6 py-4 text-sm text-destructive" data-testid="reports__error">
            {error}
          </div>
        )}

        {summary && (
          <div className="min-w-0 space-y-6 p-4">
            {/* Stat cards */}
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Total cost"
                value={formatUsd(totalCost)}
                testId="reports__total-cost"
                sub={`${summary.byModel.length} model${summary.byModel.length === 1 ? "" : "s"}`}
              />
              <StatCard
                label="Total tokens"
                value={formatTokens(totalTokens)}
                testId="reports__total-tokens"
                sub={`${formatTokens(summary.total.inputTokens)} in · ${formatTokens(summary.total.outputTokens)} out`}
              />
              <StatCard
                label="Sessions"
                value={String(sessionCount)}
                testId="reports__total-sessions"
                sub={`${summary.byAgent.length} agent${summary.byAgent.length === 1 ? "" : "s"}`}
              />
              <StatCard
                label="Top model"
                value={topModel?.bucket ?? "—"}
                testId="reports__top-model"
                sub={topModel ? formatUsd(topModel.costUsd) : "no data"}
              />
            </div>

            {/* Trend chart — daily/weekly/monthly depending on the
                server-picked `bucketSize`. The X-axis is **numeric**
                (epoch-ms) rather than categorical so recharts can
                spread ticks proportionally across the requested range
                regardless of activity gaps, and so a year-long view
                gets month-level tick labels for free. Buckets ship as
                YYYY-MM-DD strings (Monday for week, first-of-month for
                month) so `Date.parse(...)` round-trips them to
                positions. */}
            <section className="rounded-md border border-border/50 bg-card/40">
              <header className="border-b border-border/50 px-4 py-2 text-xs font-medium text-muted-foreground">
                {BUCKET_HEADING[summary.bucketSize]}
              </header>
              <div className="h-56 px-2 py-3" data-testid="reports__chart">
                {summary.byBucket.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    No usage in this range yet.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      // `T00:00:00` (no Z) parses as local-midnight, matching
                      // the server-side `'localtime'` modifier used in the
                      // bucket SQL. Without the suffix `Date.parse("YYYY-MM-DD")`
                      // would be parsed as UTC midnight, shifting points
                      // half a bucket in non-UTC zones.
                      data={summary.byBucket.map((d) => ({
                        bucketMs: Date.parse(`${d.bucket}T00:00:00`),
                        cost: d.costUsd,
                        tokens: d.totalTokens,
                      }))}
                      margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="reportsCostFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="currentColor" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="currentColor"
                        strokeOpacity={0.08}
                      />
                      <XAxis
                        type="number"
                        dataKey="bucketMs"
                        // Pin the domain to the requested range so the
                        // chart spans the full window even when data
                        // only covers part of it (e.g. fresh install
                        // with a "Last year" preset).
                        domain={[summary.fromMs, summary.toMs]}
                        scale="time"
                        tickFormatter={(v: number) => formatBucketTick(v, summary.bucketSize)}
                        tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        tickFormatter={(v: number) => formatUsd(v)}
                        tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }}
                        tickLine={false}
                        axisLine={false}
                        width={56}
                      />
                      <Tooltip
                        cursor={{ stroke: "currentColor", strokeOpacity: 0.2 }}
                        contentStyle={{
                          background: "var(--popover, #1e1e1e)",
                          border: "1px solid var(--border, #333)",
                          borderRadius: 6,
                          fontSize: 12,
                          padding: "6px 8px",
                        }}
                        // recharts types `value` as `ValueType | undefined`
                        // because Tooltip is reused across every chart kind.
                        // The Area chart above only ever emits numeric points,
                        // so we coerce to number locally rather than widen the
                        // formatter signature for callers who don't need it.
                        formatter={(value, name) => {
                          const n = typeof value === "number" ? value : Number(value);
                          return name === "cost"
                            ? [formatUsd(n), "Cost"]
                            : [formatTokens(n), "Tokens"];
                        }}
                        labelFormatter={(label) => {
                          const n = typeof label === "number" ? label : Number(label);
                          return formatBucketTooltipLabel(n, summary.bucketSize);
                        }}
                        labelStyle={{ color: "currentColor", opacity: 0.7 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="cost"
                        stroke="currentColor"
                        strokeWidth={2}
                        fill="url(#reportsCostFill)"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            {/* Breakdown tables. `min-w-0` on the grid (and on each
                `BreakdownTable` section below) lets grid items shrink to
                the parent width instead of letting their table contents
                push the grid horizontally — without it, the dialog
                overflows the viewport on mobile (issue #425 follow-up). */}
            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
              <BreakdownTable
                title="By model"
                rows={summary.byModel}
                totalCost={totalCost}
                testId="reports__by-model"
                emptyLabel="No model data yet."
              />
              <BreakdownTable
                title="By project"
                rows={summary.byProject}
                totalCost={totalCost}
                testId="reports__by-project"
                emptyLabel="No project data yet."
              />
              <BreakdownTable
                title="By agent"
                rows={summary.byAgent}
                totalCost={totalCost}
                testId="reports__by-agent"
                emptyLabel="No agent data yet."
              />
              <BreakdownTable
                title="By workspace"
                rows={summary.byWorkspace}
                totalCost={totalCost}
                testId="reports__by-workspace"
                emptyLabel="No workspace data yet."
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId: string;
}) {
  return (
    // `min-w-0` lets the card shrink inside the grid cell on mobile;
    // `truncate` on the value + `title` for accessibility keeps long
    // model ids (e.g. "claude-sonnet-4-6") inside the card.
    <div
      className="min-w-0 rounded-md border border-border/50 bg-card/40 px-4 py-3"
      data-testid={testId}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums" title={value}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  totalCost,
  testId,
  emptyLabel,
}: {
  title: string;
  rows: AggregateRow[];
  totalCost: number;
  testId: string;
  emptyLabel: string;
}) {
  // Sort by cost first, then tokens — matches the eyeball question
  // "what's most expensive" even when several rows share a $0 cost.
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
        return b.totalTokens - a.totalTokens;
      }),
    [rows],
  );

  return (
    // `min-w-0` lets the section shrink to its grid cell on mobile; the
    // `overflow-x-auto` wrapper around the table is the actual scroll
    // surface when 5 numeric columns can't fit. Without both, the table
    // forces the section wider than the grid cell, which forces the
    // dialog wider than the viewport.
    <section className="min-w-0 rounded-md border border-border/50 bg-card/40" data-testid={testId}>
      <header className="border-b border-border/50 px-4 py-2 text-xs font-medium text-muted-foreground">
        {title}
      </header>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/30">
                <th className="px-3 py-1.5 text-left font-medium">Label</th>
                <th className="px-3 py-1.5 text-right font-medium">Sessions</th>
                <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
                <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                <th className="px-3 py-1.5 text-right font-medium">% cost</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.bucket}
                  className="border-b border-border/20 last:border-0 hover:bg-accent/40"
                >
                  <td className="px-3 py-1.5 text-left font-medium" title={row.bucket}>
                    <span className="block max-w-[20ch] truncate">{row.bucket}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right">{row.sessionCount}</td>
                  <td className="px-3 py-1.5 text-right">{formatTokens(row.totalTokens)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {row.costUsd === 0 ? (
                      <span className="text-muted-foreground" title="cost unavailable">
                        —
                      </span>
                    ) : (
                      formatUsd(row.costUsd)
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {totalCost === 0 ? "—" : formatPercent(row.costUsd, totalCost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
