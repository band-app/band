import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, RefreshCw } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc-client";

interface UsageWindow {
  label: string;
  percent: number;
  resetsAt: number | null;
}

interface UsageRow {
  provider: string;
  account: string | null;
  plan: string | null;
  windows: UsageWindow[];
  hosts: string[];
}

interface UsageProblem {
  provider: string;
  reason: string;
  message: string;
  hosts: string[];
}

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };
const WARN_PERCENT = 80;
const DANGER_PERCENT = 95;
const STALE_MS = 60_000;

function toneClass(percent: number): string {
  if (percent >= DANGER_PERCENT) return "bg-danger";
  if (percent >= WARN_PERCENT) return "bg-warning";
  return "bg-success";
}

/** "2h 7m", "3d 4h" or "12m". */
function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** The soonest reset among a row's windows, as "Resets in 2h 7m". */
function resetLabel(windows: UsageWindow[], now = Date.now()): string | null {
  const times = windows.map((w) => w.resetsAt).filter((t): t is number => t !== null);
  if (times.length === 0) return null;
  const soonest = Math.min(...times);
  return soonest <= now ? "Resets now" : `Resets in ${formatDuration(soonest - now)}`;
}

function rowKey(row: UsageRow): string {
  return `${row.provider}:${row.account ?? row.hosts.join(",")}`;
}

function UsageRowView({ row }: { row: UsageRow }) {
  const reset = resetLabel(row.windows);
  return (
    <div className="space-y-1.5" data-testid={`account-usage__row-${row.provider}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {PROVIDER_NAMES[row.provider] ?? row.provider}
          </span>
          {row.plan && <span className="ml-1.5 text-xs text-muted-foreground">{row.plan}</span>}
        </div>
        {reset && <span className="shrink-0 text-xs text-muted-foreground">{reset}</span>}
      </div>
      <div
        className="truncate text-xs text-muted-foreground"
        title={[row.account, row.hosts.join(", ")].filter(Boolean).join(" on ")}
      >
        {[row.account, row.hosts.join(", ")].filter(Boolean).join(" · ")}
      </div>
      {row.windows.map((w) => (
        <div key={w.label} className="flex items-center gap-2" data-testid="account-usage__window">
          <span className="w-10 shrink-0 text-xs text-muted-foreground">{w.label}</span>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={`${PROVIDER_NAMES[row.provider] ?? row.provider} ${w.label}`}
            aria-valuenow={Math.round(w.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={`h-full ${toneClass(w.percent)}`} style={{ width: `${w.percent}%` }} />
          </div>
          <span className="w-9 shrink-0 text-right text-xs tabular-nums">
            {Math.round(w.percent)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Usage limits of the Claude and Codex accounts on every online host. The
 * button shows the highest percentage in use, amber from 80% and red from 95%.
 */
export function AccountUsagePopover() {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["account-usage"],
    queryFn: () => trpc.accountUsage.list.query(),
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
  });

  const rows: UsageRow[] = query.data?.rows ?? [];
  const problems: UsageProblem[] = query.data?.problems ?? [];
  const highest = rows.reduce((max, r) => Math.max(max, ...r.windows.map((w) => w.percent)), -1);

  async function refresh() {
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      queryClient.setQueryData(
        ["account-usage"],
        await trpc.accountUsage.list.query({ refresh: true }),
      );
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void query.refetch();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className={`gap-1 px-1.5 ${
                highest >= DANGER_PERCENT
                  ? "text-danger"
                  : highest >= WARN_PERCENT
                    ? "text-warning"
                    : "text-muted-foreground"
              }`}
              aria-label="Account limits"
              data-testid="repo-list__account-usage-button"
            >
              <Gauge className="size-4" />
              {highest >= 0 && (
                <span
                  className="text-xs tabular-nums"
                  data-testid="repo-list__account-usage-percent"
                >
                  {Math.round(highest)}%
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Account limits</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 space-y-3"
        data-testid="account-usage__popover"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Usage</span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh usage"
            data-testid="account-usage__refresh"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
        {query.isPending && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}
        {(query.isError || refreshFailed) && (
          <p className="text-xs text-muted-foreground" data-testid="account-usage__error">
            Couldn't load usage.
          </p>
        )}
        {rows.map((row) => (
          <UsageRowView key={rowKey(row)} row={row} />
        ))}
        {problems.map((p) => (
          <p
            key={`${p.provider}:${p.reason}`}
            className="text-xs text-muted-foreground"
            data-testid="account-usage__problem"
          >
            <span className="font-medium">{PROVIDER_NAMES[p.provider] ?? p.provider}.</span>{" "}
            {p.message}
          </p>
        ))}
        {query.data && rows.length === 0 && problems.length === 0 && (
          <p className="text-xs text-muted-foreground">No Claude or Codex accounts found.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
