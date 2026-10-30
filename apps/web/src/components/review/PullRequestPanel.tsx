import type { ChecksReport, ReviewAction, ReviewInfo, WorktreeReview } from "@band-app/plugin-api";
import type { WorktreeSideTabProps } from "@band-app/plugin-api/client";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@band-app/ui";
import {
  Ellipsis,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Loader,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { clientPluginHost as host } from "../../plugins/client-plugin-host";
import { ChecksSection } from "./ChecksSection";
import { CommentsSection } from "./CommentsSection";
import { ReviewStateBadge } from "./check-status";
import { MergeControl } from "./MergeControl";
import { ReviewersSection } from "./ReviewersSection";
import { ReviewProviderContext, runReviewAction, useWorktreeReview } from "./review-query";

// Poll faster while checks are still running, the way you watch CI.
const POLL_RUNNING_MS = 30_000;
const POLL_SETTLED_MS = 120_000;

function pollInterval(data: WorktreeReview | undefined): number {
  if (
    data?.status === "ok" &&
    (data.checks.state === "running" || data.checks.state === "pending")
  ) {
    return POLL_RUNNING_MS;
  }
  return POLL_SETTLED_MS;
}

/**
 * The pull request for the worktree's branch with its checks. When the
 * branch has no pull request, the CI jobs on the branch head.
 */
export function PullRequestPanel({ worktreeId, visible }: WorktreeSideTabProps) {
  const query = useWorktreeReview(worktreeId, {
    enabled: visible,
    refetchInterval: visible ? pollInterval : false,
  });
  const data = query.data;

  if (!data) {
    if (query.error) {
      return (
        <PanelMessage
          testid="pr-checks__error"
          message={query.error.message}
          onRetry={query.refetch}
        />
      );
    }
    return (
      <div
        className="flex flex-1 items-center justify-center py-8"
        data-testid="pr-checks__loading"
      >
        <Loader className="size-4 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (data.status === "unavailable") {
    return <PanelMessage testid="pr-checks__unavailable" message={data.message} />;
  }
  if (data.status === "error") {
    return (
      <PanelMessage testid="pr-checks__error" message={data.message} onRetry={query.refetch} />
    );
  }

  const refresh = (
    <HeaderButton
      label="Refresh"
      testid="pr-checks__refresh"
      onClick={query.refetch}
      icon={<RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} />}
    />
  );

  return (
    <ReviewProviderContext.Provider value={data.provider}>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="pr-checks">
        {data.review ? (
          <ReviewHeader
            worktreeId={worktreeId}
            review={data.review}
            providerName={data.provider.name}
            refresh={refresh}
          />
        ) : (
          <BranchHeader branch={data.branch} checks={data.checks} refresh={refresh} />
        )}
        {data.review?.reviewers && <ReviewersSection reviewers={data.review.reviewers} />}
        <ChecksSection
          worktreeId={worktreeId}
          branch={data.branch}
          review={data.review}
          checks={data.checks}
          visible={visible}
          refetch={query.refetch}
        />
        {data.review?.discussion && (
          <CommentsSection worktreeId={worktreeId} discussion={data.review.discussion} />
        )}
      </div>
    </ReviewProviderContext.Provider>
  );
}

function ReviewHeader({
  worktreeId,
  review,
  providerName,
  refresh,
}: {
  worktreeId: string;
  review: ReviewInfo;
  providerName: string;
  refresh: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2 border-b border-border px-3 py-3"
      data-testid="pr-checks__header"
    >
      <div className="flex items-center gap-2">
        <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <button
          type="button"
          className="text-sm font-semibold hover:underline"
          onClick={() => host.openUrl(review.url)}
          data-testid="pr-checks__number"
        >
          #{review.number}
        </button>
        <ReviewStateBadge state={review.state} />
        <div className="ml-auto flex items-center gap-0.5">
          {refresh}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More actions"
                data-testid="pr-checks__menu"
                className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Ellipsis className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => host.openUrl(review.url)}
                data-testid="pr-checks__menu-open"
              >
                Open on {providerName}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void navigator.clipboard?.writeText(review.url)}
                data-testid="pr-checks__menu-copy"
              >
                Copy link
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="text-sm leading-snug" data-testid="pr-checks__title">
        {review.title}
      </p>
      <p className="text-[11px] text-muted-foreground" data-testid="pr-checks__updated">
        PR updated {new Date(review.updatedAt).toLocaleString()}
      </p>
      <MergeControl worktreeId={worktreeId} review={review} />
      <HeaderActions worktreeId={worktreeId} actions={review.actions} />
    </div>
  );
}

function BranchHeader({
  branch,
  checks,
  refresh,
}: {
  branch: string;
  checks: ChecksReport;
  refresh: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 border-b border-border px-3 py-3"
      data-testid="pr-checks__header"
    >
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-sm font-semibold" data-testid="pr-checks__branch">
          {branch}
        </span>
        <div className="ml-auto flex items-center gap-0.5">{refresh}</div>
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="pr-checks__no-review">
        No pull request for this branch.
        {checks.headSha ? ` CI jobs on ${checks.headSha.slice(0, 7)}.` : ""}
      </p>
    </div>
  );
}

const ACTION_ICONS = { merge: GitMerge, rerun: RotateCw, ready: GitPullRequestArrow } as const;

/**
 * The review's header actions that have no place of their own: not part of the merge button and
 * not the re-run actions of the failing banner. Each asks for confirmation first when it has text for it.
 */
function HeaderActions({ worktreeId, actions }: { worktreeId: string; actions: ReviewAction[] }) {
  const shown = actions.filter((a) => a.placement === "header" && !a.group && a.icon !== "rerun");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (shown.length === 0) return null;

  const run = async (action: ReviewAction) => {
    if (action.confirm && !window.confirm(action.confirm)) return;
    setBusy(action.id);
    setError(null);
    try {
      await runReviewAction(worktreeId, action.id, action.args);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((action) => {
        const Icon = ACTION_ICONS[action.icon];
        return (
          <button
            key={`${action.id}:${JSON.stringify(action.args ?? {})}`}
            type="button"
            disabled={!!action.disabledReason || busy !== null}
            title={action.disabledReason}
            onClick={() => void run(action)}
            data-testid="pr-checks__action"
            data-action-id={action.id}
            className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-border text-xs font-medium hover:bg-accent disabled:cursor-default disabled:opacity-50"
          >
            {busy === action.id ? (
              <Loader className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Icon className="size-3.5" aria-hidden />
            )}
            {action.label}
          </button>
        );
      })}
      {error && (
        <p className="text-[11px] text-danger" data-testid="pr-checks__action-error">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function HeaderButton({
  label,
  icon,
  onClick,
  testid,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testid}
      className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {icon}
    </button>
  );
}

function PanelMessage({
  message,
  testid,
  onRetry,
}: {
  message: string;
  testid: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center" data-testid={testid}>
      <GitPullRequest className="size-6 text-muted-foreground/30" aria-hidden />
      <p className="text-xs text-muted-foreground">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          data-testid={`${testid}-retry`}
        >
          Try again
        </button>
      )}
    </div>
  );
}
