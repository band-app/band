import type { CheckRun, CheckState, ReviewInfo } from "@band-app/plugin-api";
import { cn } from "@band-app/ui";
import { CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX, Loader } from "lucide-react";

const CHECK_STATE: Record<
  CheckState,
  { label: string; icon: typeof CircleCheck; className: string; spin?: boolean }
> = {
  failure: { label: "Failed", icon: CircleX, className: "text-red-500" },
  running: { label: "In progress", icon: Loader, className: "text-amber-500", spin: true },
  pending: { label: "Queued", icon: CircleDashed, className: "text-amber-500" },
  cancelled: { label: "Cancelled", icon: CircleSlash, className: "text-muted-foreground" },
  success: { label: "Successful", icon: CircleCheck, className: "text-green-500" },
  neutral: { label: "Neutral", icon: CircleMinus, className: "text-muted-foreground" },
  skipped: { label: "Skipped", icon: CircleMinus, className: "text-muted-foreground" },
};

export function checkStateLabel(state: CheckState): string {
  return CHECK_STATE[state].label;
}

export function CheckStateIcon({ state, className }: { state: CheckState; className?: string }) {
  const { icon: Icon, className: color, spin } = CHECK_STATE[state];
  return (
    <Icon aria-hidden className={cn("size-4 shrink-0", color, spin && "animate-spin", className)} />
  );
}

export interface CheckCounts {
  passing: number;
  failing: number;
  pending: number;
}

export function countChecks(checks: CheckRun[]): CheckCounts {
  const counts: CheckCounts = { passing: 0, failing: 0, pending: 0 };
  for (const check of checks) {
    if (check.state === "success" || check.state === "neutral") counts.passing++;
    else if (check.state === "failure") counts.failing++;
    else if (isUnfinished(check)) counts.pending++;
  }
  return counts;
}

const REVIEW_STATE: Record<ReviewInfo["state"], { label: string; className: string }> = {
  open: { label: "Open", className: "border-green-600/40 bg-green-600/10 text-green-600" },
  draft: { label: "Draft", className: "border-border bg-muted text-muted-foreground" },
  merged: { label: "Merged", className: "border-violet-500/40 bg-violet-500/10 text-violet-500" },
  closed: { label: "Closed", className: "border-red-500/40 bg-red-500/10 text-red-500" },
};

export function ReviewStateBadge({ state }: { state: ReviewInfo["state"] }) {
  const { label, className } = REVIEW_STATE[state];
  return (
    <span
      data-testid="pr-checks__state"
      data-review-state={state}
      className={cn(
        "inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-semibold tracking-wide uppercase",
        className,
      )}
    >
      {label}
    </span>
  );
}

function formatDuration(ms: number): string | null {
  if (Number.isNaN(ms)) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** How long a check ran, e.g. `2m 14s`, or null while it has not finished. */
export function checkDuration(check: CheckRun): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  return formatDuration(Date.parse(check.completedAt) - Date.parse(check.startedAt));
}

export function isUnfinished(check: CheckRun): boolean {
  return check.state === "running" || check.state === "pending";
}

/** Whether the check has started and not finished, so its elapsed time grows. */
export function isCountingUp(check: CheckRun): boolean {
  return isUnfinished(check) && !!check.startedAt && !check.completedAt;
}

/**
 * What the Duration line says for a check that has not finished: the time
 * since GitHub's `startedAt`, or "Queued" when it has not started.
 */
export function checkElapsed(check: CheckRun, now: number): string | null {
  if (isCountingUp(check)) {
    const elapsed = formatDuration(now - Date.parse(check.startedAt as string));
    return elapsed && `Running for ${elapsed}`;
  }
  return isUnfinished(check) && !check.startedAt ? "Queued" : null;
}
