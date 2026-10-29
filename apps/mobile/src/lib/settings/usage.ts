/**
 * The Usage screen: Claude and Codex limits of the accounts logged in on online workers, as
 * `accountUsage.list` returns them. Pure, so the tests run under Node. The thresholds and the
 * reset wording match the web footer popover (`AccountUsagePopover.tsx`). A phone shows a reset
 * line per window, where the popover shows the soonest one per account.
 */

export interface UsageWindowLike {
  label: string;
  percent: number;
  resetsAt: number | null;
}

export interface UsageRowLike {
  provider: string;
  account: string | null;
  plan: string | null;
  windows: UsageWindowLike[];
  hosts: string[];
}

export interface UsageProblemLike {
  provider: string;
  reason: string;
  message: string;
  hosts: string[];
}

export interface UsageDataLike {
  rows: UsageRowLike[];
  problems: UsageProblemLike[];
}

export type UsageTone = "success" | "warning" | "danger";

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };
export const WARN_PERCENT = 80;
export const DANGER_PERCENT = 95;

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** Green below 80%, amber from 80%, red from 95%. */
export function usageTone(percent: number): UsageTone {
  if (percent >= DANGER_PERCENT) return "danger";
  if (percent >= WARN_PERCENT) return "warning";
  return "success";
}

/** A percentage as the integer shown next to a bar, kept within 0 to 100. */
export function roundedPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** "2h 7m", "3d 4h" or "12m". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** When one window resets: "Resets in 2h 7m", "Resets now", or null when the reset is unknown. */
export function windowResetText(resetsAt: number | null, now = Date.now()): string | null {
  if (resetsAt === null) return null;
  return resetsAt <= now ? "Resets now" : `Resets in ${formatDuration(resetsAt - now)}`;
}

/** The account line under a provider: the email and the workers it is logged in on. */
export function accountLine(row: UsageRowLike): string {
  const hosts = row.hosts.length > 0 ? `on ${row.hosts.join(", ")}` : "";
  return [row.account, hosts].filter(Boolean).join(" ");
}

export function rowKey(row: UsageRowLike): string {
  return `${row.provider}:${row.account ?? row.hosts.join(",")}`;
}

export function problemKey(problem: UsageProblemLike): string {
  return `${problem.provider}:${problem.reason}:${problem.hosts.join(",")}`;
}

export type UsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty"; refreshError: string | null }
  | {
      kind: "data";
      rows: UsageRowLike[];
      problems: UsageProblemLike[];
      refreshError: string | null;
    };

/**
 * What the screen shows. A failed first load shows the error. A failed refresh keeps the last
 * data and carries the error beside it. No account and no problem on any worker is empty.
 */
export function usageView(input: {
  data: UsageDataLike | undefined;
  pending: boolean;
  error: string | null;
  refreshError: string | null;
}): UsageView {
  const { data, pending, error, refreshError } = input;
  if (!data) {
    if (error || refreshError) return { kind: "error", message: refreshError ?? error ?? "" };
    return pending ? { kind: "loading" } : { kind: "empty", refreshError };
  }
  if (data.rows.length === 0 && data.problems.length === 0) {
    return { kind: "empty", refreshError: refreshError ?? error };
  }
  return {
    kind: "data",
    rows: data.rows,
    problems: data.problems,
    refreshError: refreshError ?? error,
  };
}
