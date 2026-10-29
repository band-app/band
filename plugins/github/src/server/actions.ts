import {
  type CheckRun,
  type MergeMethod,
  REVIEW_ACTION_MERGE,
  REVIEW_ACTION_READY,
  REVIEW_ACTION_RERUN_FAILED,
  REVIEW_ACTION_RERUN_JOB,
  type ReviewAction,
  type ReviewActionArgs,
  type ReviewInfo,
} from "@band-app/plugin-api";

const MERGE_METHODS: ReadonlyArray<{ method: MergeMethod; label: string }> = [
  { method: "squash", label: "Squash and merge" },
  { method: "merge", label: "Create a merge commit" },
  { method: "rebase", label: "Rebase and merge" },
];

/** Why a pull request in this merge state cannot merge now, or null when it can. */
function mergeBlock(review: Pick<ReviewInfo, "state" | "mergeState">): string | null {
  if (review.state === "draft" || review.mergeState === "draft") {
    return "Mark the PR ready for review first.";
  }
  switch (review.mergeState) {
    case "clean":
    case "has_hooks":
    case "unstable":
      return null;
    case "blocked":
      return "Required reviews or checks are missing.";
    case "behind":
      return "The branch is out of date.";
    case "dirty":
      return "The branch has merge conflicts.";
    default:
      return "GitHub is still checking whether the pull request can merge.";
  }
}

/** A finished job of a workflow run is the only kind GitHub can run again. */
function rerunnable(
  check: CheckRun,
): check is CheckRun & { rerun: NonNullable<CheckRun["rerun"]> } {
  return !!check.rerun && check.state !== "running" && check.state !== "pending";
}

/** What a person can do to this pull request now, as data for the core to draw. */
export function reviewActions(review: Omit<ReviewInfo, "actions">): ReviewAction[] {
  const actions: ReviewAction[] = [];

  if (review.state === "open" || review.state === "draft") {
    const disabledReason = mergeBlock(review) ?? undefined;
    for (const { method, label } of MERGE_METHODS) {
      actions.push({
        id: REVIEW_ACTION_MERGE,
        label,
        icon: "merge",
        placement: "header",
        group: "merge",
        args: { method },
        confirm: `${label} #${review.number}?`,
        disabledReason,
      });
    }
  }
  if (review.state === "draft") {
    actions.push({
      id: REVIEW_ACTION_READY,
      label: "Ready for review",
      icon: "ready",
      placement: "header",
    });
  }

  const failedRuns = new Set<string>();
  for (const check of review.checks.checks) {
    if (!rerunnable(check)) continue;
    actions.push({
      id: REVIEW_ACTION_RERUN_JOB,
      label: "Re-run job",
      icon: "rerun",
      placement: "check",
      args: { runId: check.rerun.runId, jobId: check.rerun.jobId, checkId: check.id },
    });
    if (check.state === "failure") failedRuns.add(check.rerun.runId);
  }
  for (const runId of failedRuns) {
    actions.push({
      id: REVIEW_ACTION_RERUN_FAILED,
      label: "Re-run failed",
      icon: "rerun",
      placement: "header",
      args: { runId },
    });
  }
  return actions;
}

function digits(args: ReviewActionArgs, key: string): string {
  const value = String(args[key] ?? "");
  if (!/^\d+$/.test(value)) throw new Error(`Action argument ${key} must be a number.`);
  return value;
}

/** The `gh` arguments for an action, without `--repo`. Throws for an unknown action or bad args. */
export function ghArgsFor(number: number, actionId: string, args: ReviewActionArgs): string[] {
  switch (actionId) {
    case REVIEW_ACTION_MERGE: {
      const method = MERGE_METHODS.find((m) => m.method === args.method);
      if (!method) throw new Error("Choose a merge method: merge, squash or rebase.");
      return ["pr", "merge", String(number), `--${method.method}`];
    }
    case REVIEW_ACTION_READY:
      return ["pr", "ready", String(number)];
    case REVIEW_ACTION_RERUN_JOB:
      return ["run", "rerun", digits(args, "runId"), "--job", digits(args, "jobId")];
    case REVIEW_ACTION_RERUN_FAILED:
      return ["run", "rerun", digits(args, "runId"), "--failed"];
    default:
      throw new Error(`GitHub has no action ${actionId}.`);
  }
}
