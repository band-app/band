/**
 * What the Checks view does with `reviews.forWorktree`, shared by the web's GitHub plugin
 * (`plugins/github/src/client/check-status.tsx`, `ChecksSection.tsx`) and the mobile app: the
 * counts, durations, which jobs can run again, and the prompt of the Fix agent. The shapes are
 * structural copies of `CheckRun` and `ReviewInfo` in `@band-app/plugin-api`.
 */

export type CheckState =
  | "success"
  | "failure"
  | "running"
  | "pending"
  | "cancelled"
  | "skipped"
  | "neutral";

export interface CheckLike {
  id: string;
  name: string;
  workflowName: string | null;
  state: CheckState;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  description: string | null;
  rerun?: { runId: string; jobId: string };
}

export interface ReviewLike {
  number: number;
  title: string;
}

/** One re-run request, as `reviews.rerunChecks` takes it. */
export interface RerunTarget {
  runId: string;
  jobId?: string;
  failedOnly?: boolean;
}

export const CHECK_STATE_LABEL: Record<CheckState, string> = {
  failure: "Failed",
  running: "In progress",
  pending: "Queued",
  cancelled: "Cancelled",
  success: "Successful",
  neutral: "Neutral",
  skipped: "Skipped",
};

export function isUnfinished(check: CheckLike): boolean {
  return check.state === "running" || check.state === "pending";
}

export interface CheckCounts {
  passing: number;
  failing: number;
  pending: number;
}

export function countChecks(checks: readonly CheckLike[]): CheckCounts {
  const counts: CheckCounts = { passing: 0, failing: 0, pending: 0 };
  for (const check of checks) {
    if (check.state === "success" || check.state === "neutral") counts.passing++;
    else if (check.state === "failure") counts.failing++;
    else if (isUnfinished(check)) counts.pending++;
  }
  return counts;
}

function formatDuration(ms: number): string | null {
  if (Number.isNaN(ms)) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** How long a check ran, e.g. `2m 14s`, or null while it has not finished. */
export function checkDuration(check: CheckLike): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  return formatDuration(Date.parse(check.completedAt) - Date.parse(check.startedAt));
}

/** Whether the check has started and not finished, so its elapsed time grows. */
export function isCountingUp(check: CheckLike): boolean {
  return isUnfinished(check) && !!check.startedAt && !check.completedAt;
}

/** What the duration line says for a check that has not finished: "Running for 3s" or "Queued". */
export function checkElapsed(check: CheckLike, now: number): string | null {
  if (isCountingUp(check)) {
    const elapsed = formatDuration(now - Date.parse(check.startedAt as string));
    return elapsed && `Running for ${elapsed}`;
  }
  return isUnfinished(check) && !check.startedAt ? "Queued" : null;
}

/** A finished job of a workflow run is the only kind GitHub can run again. */
export function canRerun(check: CheckLike): boolean {
  return !!check.rerun && !isUnfinished(check);
}

/** The check as the list shows it right after a re-run was accepted. */
export function asQueued<T extends CheckLike>(check: T): T {
  return { ...check, state: "pending", startedAt: null, completedAt: null, description: null };
}

/** The request for one job. */
export function rerunOneTarget(check: CheckLike): RerunTarget[] {
  return check.rerun ? [{ runId: check.rerun.runId, jobId: check.rerun.jobId }] : [];
}

/**
 * What "Re-run failed" asks: one `--failed` request per workflow run, however many of its jobs
 * failed, and the failing checks those requests cover.
 */
export function rerunFailedPlan(checks: readonly CheckLike[]): {
  targets: RerunTarget[];
  covered: CheckLike[];
} {
  const covered = checks.filter((c) => c.state === "failure" && canRerun(c));
  const runIds = [...new Set(covered.flatMap((c) => (c.rerun ? [c.rerun.runId] : [])))];
  return { targets: runIds.map((runId) => ({ runId, failedOnly: true })), covered };
}

/** The first message of the Fix agent, the same as the web's. */
export function fixPrompt(
  branch: string,
  review: ReviewLike | null,
  failing: readonly CheckLike[],
): string {
  const subject = review ? `pull request #${review.number} (${review.title})` : `branch ${branch}`;
  const lines = failing.map((check) => {
    const name = check.workflowName ? `${check.workflowName} / ${check.name}` : check.name;
    return `- ${name}${check.url ? `: ${check.url}` : ""}`;
  });
  return [
    `These CI checks are failing on ${subject}:`,
    ...lines,
    "",
    "Read the failing job logs (for example with `gh run view <run-id> --log-failed`), fix the causes, run the relevant checks locally, and push the fix.",
  ].join("\n");
}

/** Poll faster while checks are still running, the way you watch CI (the web's intervals). */
export const POLL_RUNNING_MS = 30_000;
export const POLL_SETTLED_MS = 120_000;
/** While a re-run waits to show up on GitHub, ask for the checks this often. */
export const RERUN_POLL_MS = 5000;
