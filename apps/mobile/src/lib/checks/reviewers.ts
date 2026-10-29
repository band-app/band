/** The parts of the hub's `Reviewer` the Checks view reads. */
export type ReviewerState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "pending"
  | "dismissed";

export interface ReviewerLike {
  login: string;
  avatarUrl: string | null;
  state: ReviewerState;
  required?: boolean;
}

/** The same wording as the web Checks tab. */
export const REVIEWER_STATE_LABEL: Record<ReviewerState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Commented",
  pending: "Pending",
  dismissed: "Dismissed",
};

/** "none", or "N/M approved". */
export function reviewersSummary(reviewers: readonly ReviewerLike[]): string {
  if (reviewers.length === 0) return "none";
  const approved = reviewers.filter((r) => r.state === "approved").length;
  return `${approved}/${reviewers.length} approved`;
}

/** The section shows when the provider reports reviewers, even an empty list. */
export function showsReviewers(review: { reviewers?: readonly ReviewerLike[] } | null): boolean {
  return Array.isArray(review?.reviewers);
}

/** The letter shown in place of an avatar. */
export function reviewerInitial(login: string): string {
  return login.slice(0, 1).toUpperCase();
}
