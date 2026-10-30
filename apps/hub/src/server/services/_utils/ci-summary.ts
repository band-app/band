import { type ChecksReport, type ReviewInfo, statePriority } from "@band-app/plugin-api";
import type { CIStatus } from "./ci-status";

/**
 * The branch-status CI fields for a review panel result, by the rules the
 * poller applies to its batched query: a merged review is `merged`, otherwise
 * the checks' overall state. The link is the open review's URL, else the URL
 * of the check that decides the state.
 */
export function ciSummaryFromChecks(checks: ChecksReport, review: ReviewInfo | null): CIStatus {
  const pr = review
    ? {
        number: review.number,
        title: review.title,
        url: review.url,
        state: review.state === "draft" ? ("open" as const) : review.state,
        isDraft: review.state === "draft",
      }
    : null;
  if (pr?.state === "merged") return { state: "merged", url: pr.url, pr };
  let checkUrl: string | null = null;
  let best = -2;
  for (const check of checks.checks) {
    const priority = statePriority(check.state);
    if (priority >= best && check.url) {
      best = priority;
      checkUrl = check.url;
    }
  }
  const prUrl = pr?.state === "open" ? pr.url : null;
  return { state: checks.state, url: prUrl ?? checkUrl, pr };
}
