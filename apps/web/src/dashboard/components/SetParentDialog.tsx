import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useHostNames } from "../hooks/use-host-names";
import { useRepos } from "../hooks/use-repos";
import { queryKeys } from "../query-client";
import type { RepoInfo, WorktreeInfo } from "../types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoName: string;
  worktree: Pick<WorktreeInfo, "name" | "hostId">;
}

/** The worktree and everything started from it, directly or through other worktrees. */
export function worktreeAndDescendants(
  repos: readonly RepoInfo[],
  worktreeId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      childrenOf.set(toWorktreeId(repo.name, wt.name, wt.hostId), wt.children ?? []);
    }
  }
  const out = new Set<string>([worktreeId]);
  const queue = [worktreeId];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const child of childrenOf.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/**
 * Picks the worktree that a worktree was started from. Lists every worktree on every repo and
 * host except the worktree itself and its descendants, which would make a cycle.
 */
export function SetParentDialog({ open, onOpenChange, repoName, worktree }: Props) {
  const { repos } = useRepos();
  const queryClient = useQueryClient();
  const hostName = useHostNames();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const worktreeId = toWorktreeId(repoName, worktree.name, worktree.hostId);

  const candidates = useMemo(() => {
    const excluded = worktreeAndDescendants(repos, worktreeId);
    return repos.flatMap((repo) =>
      repo.worktrees
        .map((wt) => ({
          worktreeId: toWorktreeId(repo.name, wt.name, wt.hostId),
          repoName: repo.name,
          name: wt.title || wt.name,
          branch: wt.branch,
          hostId: wt.hostId,
        }))
        .filter((c) => !excluded.has(c.worktreeId)),
    );
  }, [repos, worktreeId]);
  const showHost =
    new Set(repos.flatMap((r) => r.worktrees.map((w) => w.hostId ?? "local"))).size > 1;

  const choose = async (parentId: string) => {
    setBusy(true);
    setError(null);
    try {
      await trpc.worktrees.setOrigin.mutate({
        repo: repoName,
        name: worktree.name,
        hostId: worktree.hostId,
        origin: parentId,
      });
      // Close first: the card that owns this dialog moves in the list once the new parent
      // shows, and a dialog unmounted while still open leaves the page unclickable.
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="command-palette"
        className="overflow-hidden p-0 lg:max-w-[520px]"
        showCloseButton={false}
        data-testid="set-parent__dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Set parent</DialogTitle>
          <DialogDescription>
            Choose the worktree {worktree.name} was started from
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={true}>
          <CommandInput placeholder={`Set parent of ${worktree.name}...`} />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No worktrees found.</CommandEmpty>
            {candidates.map((c) => (
              <CommandItem
                key={c.worktreeId}
                value={`${c.repoName} ${c.name} ${c.branch} ${showHost ? hostName(c.hostId === "local" ? undefined : c.hostId) : ""}`}
                disabled={busy}
                onSelect={() => void choose(c.worktreeId)}
                data-testid={`set-parent__item--${c.worktreeId}`}
              >
                <span className="truncate">
                  {c.repoName} · {c.name}
                </span>
                {showHost && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {hostName(c.hostId === "local" ? undefined : c.hostId)}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        {error && (
          <p
            role="alert"
            className="px-3 pb-2 text-xs text-destructive"
            data-testid="set-parent__error"
          >
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
