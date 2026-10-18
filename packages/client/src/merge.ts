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

export interface MergeStatusInput {
  state: string;
  mergeState: string;
}

export interface MergeStatus {
  label: string;
  canMerge: boolean;
  hint: string;
}

/** The main button's label and whether it can merge, from the PR's state. */
export function mergeStatus(review: MergeStatusInput): MergeStatus {
  if (review.state === "merged") return { label: "Merged", canMerge: false, hint: "" };
  if (review.state === "closed") return { label: "Closed", canMerge: false, hint: "" };
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

/** "3 minutes ago", "yesterday". Falls back to the input for a date it cannot read. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = seconds;
  for (const [size, unit] of units) {
    if (value < size) {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-value, unit);
    }
    value = Math.floor(value / size);
  }
  return iso;
}
