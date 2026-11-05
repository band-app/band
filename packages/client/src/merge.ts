/**
 * The pull request panel's merge button and comment header text, shared by the web's GitHub
 * plugin and the mobile Checks screen. Pure functions, no DOM.
 */

export type MergeMethod = "merge" | "squash" | "rebase";

export const MERGE_METHODS: ReadonlyArray<{ method: MergeMethod; label: string }> = [
  { method: "squash", label: "Squash and merge" },
  { method: "merge", label: "Create a merge commit" },
  { method: "rebase", label: "Rebase and merge" },
];

/** A pull request's place in the forge's merge queue (a structural copy of `MergeQueueInfo`). */
export interface MergeQueueLike {
  state: "queued" | "awaiting_checks" | "mergeable" | "locked" | "unmergeable";
  position: number;
  total?: number | null;
  estimatedTimeToMerge?: number | null;
}

export interface MergeStatusInput {
  state: string;
  mergeState: string;
  mergeQueue?: MergeQueueLike | null;
}

export interface MergeStatus {
  label: string;
  canMerge: boolean;
  hint: string;
  /** The pull request is in the merge queue, so the main button gives way to a note. */
  queued?: boolean;
}

/** GitHub's entry state for a queued pull request, as the web's Checks panel words it. */
export const QUEUE_STATE_LABEL = {
  queued: "queued",
  awaiting_checks: "awaiting checks",
  mergeable: "ready to merge",
  locked: "locked",
  unmergeable: "has conflicts",
} as const;

/** "In merge queue · position 2", the text of the web's worktree badge. */
export function queueBadgeLabel(queue: Pick<MergeQueueLike, "position">): string {
  return `In merge queue · position ${queue.position}`;
}

/** "In merge queue, position 2 of 3 (awaiting checks)", the web's Checks panel line. */
export function queueLine(queue: MergeQueueLike): string {
  const position = queue.total
    ? `position ${queue.position} of ${queue.total}`
    : `position ${queue.position}`;
  return `In merge queue, ${position} (${QUEUE_STATE_LABEL[queue.state]})`;
}

/** "about 5 min" for GitHub's estimate in seconds, or null when there is none. */
export function queueEstimate(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return "less than a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}

/** The Checks line for auto-merge armed before the pull request is queued. */
export const AUTO_MERGE_LINE = "Auto-merge on, waiting for checks";

/** The main button's label and whether it can merge, from the PR's state. */
export function mergeStatus(review: MergeStatusInput): MergeStatus {
  if (review.state === "merged") return { label: "Merged", canMerge: false, hint: "" };
  if (review.state === "closed") return { label: "Closed", canMerge: false, hint: "" };
  if (review.mergeQueue) {
    return { label: "In merge queue", canMerge: false, hint: "", queued: true };
  }
  switch (review.mergeState) {
    case "clean":
    case "has_hooks":
      return { label: "Squash and merge", canMerge: true, hint: "" };
    case "unstable":
      return {
        label: "Squash and merge",
        canMerge: true,
        hint: "Some checks that are not required are failing.",
      };
    case "blocked":
      return {
        label: "Blocked",
        canMerge: false,
        hint: "Required reviews or checks are missing.",
      };
    case "behind":
      return { label: "Behind base", canMerge: false, hint: "The branch is out of date." };
    case "dirty":
      return { label: "Conflicts", canMerge: false, hint: "The branch has merge conflicts." };
    case "draft":
      return { label: "Draft", canMerge: false, hint: "Mark the PR ready for review first." };
    default:
      return { label: "Checking mergeability", canMerge: false, hint: "" };
  }
}

/** The label of a merge method. */
export function mergeMethodLabel(method: MergeMethod): string {
  return MERGE_METHODS.find((m) => m.method === method)?.label ?? method;
}

/** What a review summary's author did, shown after their name. */
export const REVIEW_LABEL = {
  approved: "approved",
  changes_requested: "requested changes",
  commented: "reviewed",
  pending: "reviewed",
  dismissed: "review dismissed",
} as const;

/**
 * "3 minutes ago", "yesterday". Falls back to the input for a date it cannot read.
 * Written out by hand because Hermes, the mobile app's JS engine, has no `Intl.RelativeTimeFormat`.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 1) return "now";
  const units: Array<[number, string, string]> = [
    [60, "second", ""],
    [60, "minute", ""],
    [24, "hour", ""],
    [30, "day", "yesterday"],
    [12, "month", "last month"],
    [Number.POSITIVE_INFINITY, "year", "last year"],
  ];
  let value = seconds;
  for (const [size, unit, one] of units) {
    if (value < size) {
      if (value === 1 && one) return one;
      return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
    }
    value = Math.floor(value / size);
  }
  return iso;
}
