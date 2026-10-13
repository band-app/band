import type { ReviewComment, ReviewDiscussion, ReviewThread } from "@band-app/plugin-api";
import { useClientPluginHost } from "@band-app/plugin-api/client";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@band-app/ui";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { PanelSection } from "./PanelSection";
import { Avatar } from "./ReviewersSection";

const REVIEW_LABEL = {
  approved: "approved",
  changes_requested: "requested changes",
  commented: "reviewed",
  pending: "reviewed",
  dismissed: "review dismissed",
} as const;

function relativeTime(iso: string, now = Date.now()): string {
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

export function CommentsSection({
  worktreeId,
  discussion,
}: {
  worktreeId: string;
  discussion: ReviewDiscussion;
}) {
  const total = discussion.items.length + discussion.threads.length;
  const unresolved = discussion.threads.filter((t) => !t.isResolved).length;
  const summary =
    total === 0
      ? "none"
      : `${total}${discussion.threads.length > 0 ? `, ${unresolved} unresolved` : ""}`;
  // Oldest first, so the newest message is last.
  const entries = [
    ...discussion.items.map((item) => ({
      key: item.id,
      at: item.createdAt,
      node: <ConversationItem key={item.id} item={item} />,
    })),
    ...discussion.threads.map((thread) => ({
      key: thread.id,
      at: thread.comments[0].createdAt,
      node: <Thread key={thread.id} worktreeId={worktreeId} thread={thread} />,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <PanelSection id="comments" title="Comments" summary={summary}>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="pr-comments__empty">
          No comments yet.
        </p>
      ) : (
        <ul data-testid="pr-comments__list">{entries.map((entry) => entry.node)}</ul>
      )}
      {discussion.truncated && (
        <p className="px-3 py-2 text-[11px] text-muted-foreground" data-testid="pr-comments__more">
          Older comments are on GitHub.
        </p>
      )}
    </PanelSection>
  );
}

function ConversationItem({ item }: { item: ReviewDiscussion["items"][number] }) {
  return (
    <li
      className="border-b border-border/60 px-3 py-2.5"
      data-testid="pr-comments__item"
      data-kind={item.kind}
    >
      <MessageHeader
        comment={item}
        verb={item.kind === "review" && item.reviewState ? REVIEW_LABEL[item.reviewState] : null}
      />
      <Body comment={item} />
    </li>
  );
}

function Thread({ worktreeId, thread }: { worktreeId: string; thread: ReviewThread }) {
  const host = useClientPluginHost();
  const label = thread.isResolved ? "Resolved" : thread.isOutdated ? "Outdated" : null;
  const [open, setOpen] = useState(label === null);
  const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
  return (
    <li
      className="border-b border-border/60"
      data-testid="pr-comments__thread"
      data-resolved={thread.isResolved}
      data-outdated={thread.isOutdated}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-3 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Collapse thread" : "Expand thread"}
              data-testid="pr-comments__thread-toggle"
              className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground"
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          </CollapsibleTrigger>
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-mono text-[11px] hover:underline"
            title={`Open ${location}`}
            onClick={() => host.openFile(worktreeId, thread.path, thread.line)}
            data-testid="pr-comments__thread-location"
          >
            {location}
          </button>
          {label && (
            <span
              className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              data-testid="pr-comments__thread-label"
            >
              {label}
            </span>
          )}
        </div>
        <CollapsibleContent>
          <ul className="pb-1 pl-5" data-testid="pr-comments__thread-messages">
            {thread.comments.map((comment) => (
              <li key={comment.id} className="px-3 py-1.5" data-testid="pr-comments__message">
                <MessageHeader comment={comment} verb={null} />
                <Body comment={comment} />
              </li>
            ))}
          </ul>
          {thread.truncated && (
            <p className="px-8 pb-2 text-[11px] text-muted-foreground">More replies on GitHub.</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function MessageHeader({ comment, verb }: { comment: ReviewComment; verb: string | null }) {
  const host = useClientPluginHost();
  return (
    <div className="mb-1 flex items-center gap-2">
      <Avatar login={comment.author.login} url={comment.author.avatarUrl} />
      <span className="min-w-0 truncate text-[12px] font-semibold">{comment.author.login}</span>
      {verb && <span className="shrink-0 text-[11px] text-muted-foreground">{verb}</span>}
      <time
        className="shrink-0 text-[11px] text-muted-foreground"
        dateTime={comment.createdAt}
        title={new Date(comment.createdAt).toLocaleString()}
      >
        {relativeTime(comment.createdAt)}
      </time>
      {comment.url && (
        <a
          href={comment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open comment on GitHub"
          data-testid="pr-comments__link"
          onClick={(e) => {
            e.preventDefault();
            host.openUrl(comment.url as string);
          }}
          className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

function Body({ comment }: { comment: ReviewComment }) {
  const { Markdown } = useClientPluginHost();
  return (
    <div className="pl-7" data-testid="pr-comments__body">
      <Markdown>{comment.body}</Markdown>
    </div>
  );
}
