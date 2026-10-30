import { mergeStatus } from "@band-app/client/merge";
import type { ReviewAction, ReviewInfo } from "@band-app/plugin-api";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { ChevronDown, GitMerge, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clientPluginHost as host } from "../../plugins/client-plugin-host";
import { runReviewAction, useReviewProviderInfo } from "./review-query";

const MERGE_GROUP = "merge";

/**
 * The merge button, its method menu and the inline confirm step. The methods are the
 * review's actions in the `merge` group; the first is the default.
 */
export function MergeControl({ worktreeId, review }: { worktreeId: string; review: ReviewInfo }) {
  const provider = useReviewProviderInfo();
  const mergeActions = review.actions.filter((a) => a.group === MERGE_GROUP);
  const [confirming, setConfirming] = useState<ReviewAction | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const status = mergeStatus(review);
  const merged = review.state === "merged";

  const merge = async (action: ReviewAction) => {
    setMerging(true);
    setError(null);
    try {
      await runReviewAction(worktreeId, action.id, action.args);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  };

  useEffect(() => {
    if (!confirming) return;
    confirmRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !merging) setConfirming(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirming, merging]);

  const defaultAction = mergeActions[0];
  const tone = status.canMerge
    ? "bg-success text-success-foreground hover:bg-success/90"
    : "bg-success/50 text-success-foreground/80";

  if (merged) {
    // The merge is done, so the useful next step is removing the worktree. The host
    // asks first when it holds uncommitted or unpushed work.
    return (
      <button
        type="button"
        onClick={() => host.deleteWorktree(worktreeId)}
        data-testid="pr-checks__delete-worktree"
        className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-danger text-xs font-medium text-danger-foreground hover:bg-danger/90"
      >
        <Trash2 className="size-3.5" aria-hidden />
        Delete worktree
      </button>
    );
  }

  if (!defaultAction) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {confirming ? (
        <div
          className="flex h-8 items-center overflow-hidden rounded-md border border-border bg-accent"
          data-testid="pr-checks__merge-confirm"
        >
          <span className="min-w-0 flex-1 truncate whitespace-nowrap px-2.5 text-xs">
            {confirming.confirm ?? `${confirming.label} #${review.number}?`}
          </span>
          <button
            type="button"
            className="px-2 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default"
            onClick={() => setConfirming(null)}
            disabled={merging}
            data-testid="pr-checks__merge-cancel"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="h-full bg-success px-3.5 text-xs font-semibold text-success-foreground hover:bg-success/90 disabled:cursor-default"
            onClick={() => void merge(confirming)}
            disabled={merging}
            data-testid="pr-checks__merge-confirm-button"
          >
            {merging ? "Merging…" : "Confirm"}
          </button>
        </div>
      ) : (
        <div className="flex h-8 overflow-hidden rounded-md" title={status.hint || undefined}>
          <button
            type="button"
            disabled={!status.canMerge || !!defaultAction.disabledReason || merging}
            onClick={() => setConfirming(defaultAction)}
            data-testid="pr-checks__merge"
            data-merge-state={review.mergeState}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 text-xs font-medium disabled:cursor-default",
              tone,
            )}
          >
            <GitMerge className="size-3.5" aria-hidden />
            {status.label}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Merge options"
                data-testid="pr-checks__merge-menu"
                className={cn(
                  "flex w-8 items-center justify-center border-l border-scrim",
                  "bg-success text-success-foreground hover:bg-success/90",
                )}
              >
                <ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mergeActions.map((action) => (
                <DropdownMenuItem
                  key={String(action.args?.method ?? action.label)}
                  disabled={!status.canMerge || !!action.disabledReason}
                  onSelect={() => setConfirming(action)}
                  data-testid={`pr-checks__merge-method--${action.args?.method}`}
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => host.openUrl(review.url)}>
                Open on {provider.name}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {status.hint && !status.canMerge && (
        <p className="text-[11px] text-muted-foreground" data-testid="pr-checks__merge-hint">
          {status.hint}
        </p>
      )}
      {error && (
        <p className="text-[11px] text-danger" data-testid="pr-checks__merge-error">
          {error}
        </p>
      )}
    </div>
  );
}
