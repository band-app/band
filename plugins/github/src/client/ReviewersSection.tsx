import type { Reviewer, ReviewerState } from "@band-app/plugin-api";
import { Asterisk, Check, Circle, FileDiff, MessageSquare, MinusCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { PanelSection } from "./PanelSection";

const STATE_LABEL: Record<ReviewerState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Commented",
  pending: "Pending",
  dismissed: "Dismissed",
};

const STATE_COLOR: Record<ReviewerState, string> = {
  approved: "text-success",
  changes_requested: "text-danger",
  commented: "text-muted-foreground",
  pending: "text-warning",
  dismissed: "text-muted-foreground",
};

const STATE_ICON: Record<ReviewerState, ReactElement> = {
  approved: <Check className="size-3.5" aria-hidden />,
  changes_requested: <FileDiff className="size-3.5" aria-hidden />,
  commented: <MessageSquare className="size-3.5" aria-hidden />,
  pending: <Circle className="size-2.5 fill-current" aria-hidden />,
  dismissed: <MinusCircle className="size-3.5" aria-hidden />,
};

/** URLs that failed to load in this page session, so a remount shows the initial without a request. */
const failedAvatarUrls = new Set<string>();

/** The image, or the initial letter when there is no URL or it fails to load. */
export function Avatar({ login, url }: { login: string; url: string | null }) {
  const [, setFailureCount] = useState(0);
  return url && !failedAvatarUrls.has(url) ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        failedAvatarUrls.add(url);
        setFailureCount((n) => n + 1);
      }}
      className="size-5 shrink-0 rounded-full"
      data-testid="pr-avatar__image"
    />
  ) : (
    <span
      aria-hidden
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] uppercase"
      data-testid="pr-avatar__fallback"
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
                <span
                  role="img"
                  aria-label="Required"
                  title="Required"
                  className="inline-flex shrink-0 text-muted-foreground"
                  data-testid="pr-reviewers__required"
                >
                  <Asterisk className="size-3.5" aria-hidden />
                </span>
              )}
              <span
                role="img"
                aria-label={STATE_LABEL[reviewer.state]}
                title={STATE_LABEL[reviewer.state]}
                className={`inline-flex size-4 shrink-0 items-center justify-center ${STATE_COLOR[reviewer.state]}`}
                data-testid="pr-reviewers__state"
              >
                {STATE_ICON[reviewer.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
