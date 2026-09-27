import type { ChecksReport, ReviewInfo, WorkspaceReview } from "@band-app/plugin-api";
import { useClientPluginHost, type WorkspaceSideTabProps } from "@band-app/plugin-api/client";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { Ellipsis, GitBranch, GitPullRequest, Loader, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { ChecksSection } from "./ChecksSection";
import { ReviewStateBadge } from "./check-status";
import { MergeControl } from "./MergeControl";

// Poll faster while checks are still running, the way you watch CI.
const POLL_RUNNING_MS = 30_000;
const POLL_SETTLED_MS = 120_000;

function pollInterval(data: WorkspaceReview | undefined): number {
  if (
    data?.status === "ok" &&
    (data.checks.state === "running" || data.checks.state === "pending")
  ) {
    return POLL_RUNNING_MS;
  }
  return POLL_SETTLED_MS;
}

/**
 * The pull request for the workspace's branch with its checks. When the
 * branch has no pull request, the GitHub Actions jobs on the branch head.
 */
export function PullRequestPanel({ workspaceId, visible }: WorkspaceSideTabProps) {
  const host = useClientPluginHost();
  const query = host.useWorkspaceReview(workspaceId, {
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
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="pr-checks">
      {data.review ? (
        <ReviewHeader workspaceId={workspaceId} review={data.review} refresh={refresh} />
      ) : (
        <BranchHeader branch={data.branch} checks={data.checks} refresh={refresh} />
      )}
      <ChecksSection
        workspaceId={workspaceId}
        branch={data.branch}
        review={data.review}
        checks={data.checks}
      />
    </div>
  );
}

function ReviewHeader({
  workspaceId,
  review,
  refresh,
}: {
  workspaceId: string;
  review: ReviewInfo;
  refresh: ReactNode;
}) {
  const host = useClientPluginHost();
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
                Open on GitHub
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
      <MergeControl workspaceId={workspaceId} review={review} />
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
        {checks.headSha ? ` GitHub Actions jobs on ${checks.headSha.slice(0, 7)}.` : ""}
      </p>
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
