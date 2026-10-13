import type { Reviewer, ReviewerState } from "@band-app/plugin-api";
import { PanelSection } from "./PanelSection";

const STATE_LABEL: Record<ReviewerState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Commented",
  pending: "Pending",
  dismissed: "Dismissed",
};

const STATE_COLOR: Record<ReviewerState, string> = {
  approved: "text-green-500",
  changes_requested: "text-red-500",
  commented: "text-muted-foreground",
  pending: "text-yellow-500",
  dismissed: "text-muted-foreground",
};

export function Avatar({ login, url }: { login: string; url: string | null }) {
  return url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="size-5 shrink-0 rounded-full"
    />
  ) : (
    <span
      aria-hidden
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] uppercase"
    >
      {login.slice(0, 1)}
    </span>
  );
}

export function ReviewersSection({ reviewers }: { reviewers: Reviewer[] }) {
  const approved = reviewers.filter((r) => r.state === "approved").length;
  return (
    <PanelSection
      id="reviewers"
      title="Reviewers"
      summary={reviewers.length === 0 ? "none" : `${approved}/${reviewers.length} approved`}
    >
      {reviewers.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="pr-reviewers__empty">
          No reviewers requested yet.
        </p>
      ) : (
        <ul data-testid="pr-reviewers__list">
          {reviewers.map((reviewer) => (
            <li
              key={reviewer.login}
              className="flex items-center gap-2 border-b border-border/60 px-3 py-2"
              data-testid="pr-reviewers__reviewer"
              data-reviewer-state={reviewer.state}
            >
              <Avatar login={reviewer.login} url={reviewer.avatarUrl} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{reviewer.login}</span>
              {reviewer.required && (
                <span className="shrink-0 text-[10px] text-muted-foreground">Required</span>
              )}
              <span
                className={`shrink-0 text-[11px] ${STATE_COLOR[reviewer.state]}`}
                data-testid="pr-reviewers__state"
              >
                {STATE_LABEL[reviewer.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
