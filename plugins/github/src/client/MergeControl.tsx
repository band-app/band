import type { MergeMethod, ReviewInfo } from "@band-app/plugin-api";
import { useClientPluginHost } from "@band-app/plugin-api/client";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { ChevronDown, GitMerge } from "lucide-react";
import { useState } from "react";

const MERGE_METHODS: Array<{ method: MergeMethod; label: string }> = [
  { method: "squash", label: "Squash and merge" },
  { method: "merge", label: "Create a merge commit" },
  { method: "rebase", label: "Rebase and merge" },
];

/** The main button's label and whether it can merge, from the PR's state. */
function mergeStatus(review: ReviewInfo): { label: string; canMerge: boolean; hint: string } {
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

/** The merge button, its method menu and the inline confirm step. */
export function MergeControl({ workspaceId, review }: { workspaceId: string; review: ReviewInfo }) {
  const host = useClientPluginHost();
  const [confirming, setConfirming] = useState<MergeMethod | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = mergeStatus(review);
  const merged = review.state === "merged";

  const merge = async (method: MergeMethod) => {
    setMerging(true);
    setError(null);
    try {
      await host.mergeReview(workspaceId, method);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  };

  const tone = merged
    ? "bg-violet-600 text-white"
    : status.canMerge
      ? "bg-green-700 text-white hover:bg-green-600"
      : "bg-green-700/50 text-white/80";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-8 overflow-hidden rounded-md" title={status.hint || undefined}>
        <button
          type="button"
          disabled={!status.canMerge || merging}
          onClick={() => setConfirming("squash")}
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
                "flex w-8 items-center justify-center border-l border-black/20",
                merged ? "bg-violet-600 text-white" : "bg-green-700 text-white hover:bg-green-600",
              )}
            >
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {MERGE_METHODS.map(({ method, label }) => (
              <DropdownMenuItem
                key={method}
                disabled={!status.canMerge}
                onSelect={() => setConfirming(method)}
                data-testid={`pr-checks__merge-method--${method}`}
              >
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => host.openUrl(review.url)}>
              Open on GitHub
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {status.hint && !status.canMerge && (
        <p className="text-[11px] text-muted-foreground" data-testid="pr-checks__merge-hint">
          {status.hint}
        </p>
      )}
      {confirming && (
        <div
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
          data-testid="pr-checks__merge-confirm"
        >
          <span className="min-w-0 flex-1">
            {MERGE_METHODS.find((m) => m.method === confirming)?.label} #{review.number}?
          </span>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent"
            onClick={() => setConfirming(null)}
            disabled={merging}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-green-700 px-2 py-0.5 font-medium text-white hover:bg-green-600"
            onClick={() => void merge(confirming)}
            disabled={merging}
            data-testid="pr-checks__merge-confirm-button"
          >
            {merging ? "Merging…" : "Merge"}
          </button>
        </div>
      )}
      {error && (
        <p className="text-[11px] text-red-500" data-testid="pr-checks__merge-error">
          {error}
        </p>
      )}
    </div>
  );
}
