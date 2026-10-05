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
import { Home, Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCapabilities } from "../context";
import { usePinnedWorktrees } from "../hooks/use-pinned-worktrees";
import { useRepos } from "../hooks/use-repos";
import { getRecentWorktreeOrder, recordWorktreeAccess } from "../lib/recent-worktrees";
import { useDashboardStore } from "../stores/index";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { WorktreeLabel } from "./WorktreeLabel";

interface WorktreeEntry {
  worktreeId: string;
  repoName: string;
  /** Stable worktree identity/label (see `WorktreeInfo.name`). */
  name: string;
  /** Live git branch — kept for search only. */
  branch: string;
  /**
   * True when this worktree is the repo's main checkout (its default-branch
   * worktree, and the repo is a git repo). Marked with a house icon
   * instead of the branch glyph, mirroring the repo-list root card.
   */
  isRoot: boolean;
}

interface WorktreePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorktreePickerDialog({ open, onOpenChange }: WorktreePickerDialogProps) {
  const { repos } = useRepos();
  const capabilities = useCapabilities();
  const activeWorktreeId = useDashboardStore((s) => s.activeWorktreeId);
  const statuses = useDashboardStore((s) => s.statuses);
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  const { isPinned, toggle: togglePinned } = usePinnedWorktrees();

  const [query, setQuery] = useState("");

  // Read recent order once when the dialog opens
  const [recentOrder, setRecentOrder] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setRecentOrder(getRecentWorktreeOrder());
    } else {
      setQuery("");
    }
  }, [open]);

  // Flatten all worktrees and sort strictly by most-recently-accessed. The
  // active worktree floats to the top (it's what the user just left / is on),
  // then everything else follows the recent-access order. Pinned status does
  // NOT affect ordering here — pinning is a sidebar-grouping affordance, so a
  // rarely-touched pinned worktree must not jump above one the user just used.
  const sortedWorktrees = useMemo(() => {
    const entries: WorktreeEntry[] = [];
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        const worktreeId = toWorktreeId(repo.name, worktree.name);
        entries.push({
          worktreeId,
          repoName: repo.name,
          name: worktree.name,
          branch: worktree.branch,
          // A git repo's default-branch worktree is its main checkout (the
          // repo root). Plain repos have no root/feature distinction.
          isRoot: repo.kind !== "plain" && worktree.name === repo.defaultBranch,
        });
      }
    }

    const orderMap = new Map(recentOrder.map((id, i) => [id, i]));
    entries.sort((a, b) => {
      if (a.worktreeId === activeWorktreeId) return -1;
      if (b.worktreeId === activeWorktreeId) return 1;
      const ai = orderMap.get(a.worktreeId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderMap.get(b.worktreeId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

    return entries;
    // `statuses` is intentionally NOT a dependency: agent status is read per row
    // at render time (below), not baked into the sorted entries. Otherwise every
    // ~1 Hz agent-status tick would re-run this whole flatten + sort while the
    // picker is open — precisely when agents are busiest.
  }, [repos, recentOrder, activeWorktreeId]);

  const handleSelect = useCallback(
    (worktreeId: string) => {
      clearNeedsAttention(worktreeId);
      // Recency is recorded on explicit picker selection. Navigating via URL,
      // browser back/forward, or the repo-list sidebar does NOT currently
      // update the recency store — those paths keep their existing order until
      // the worktree is next chosen through the picker. (Broadening recording
      // to every navigation path is a possible follow-up.)
      recordWorktreeAccess(worktreeId);
      const href = capabilities.getWorktreeHref?.(worktreeId);
      if (href && capabilities.navigate) {
        capabilities.navigate(href);
      } else {
        openWorktree(worktreeId);
      }
      onOpenChange(false);
    },
    [capabilities, openWorktree, clearNeedsAttention, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Mobile: slides up as a bottom drawer with the search input pinned
        // below the list. Desktop: floating card anchored in the upper third,
        // input fixed while the list grows downward. Uses the shared
        // command-palette surface + dark overlay so it matches the other four
        // command dialogs (quick open, find in files, command palette, language
        // picker).
        variant="command-palette"
        className="overflow-hidden p-0 lg:max-w-[520px]"
        showCloseButton={false}
        data-testid="worktree-picker"
        // On touch devices, don't auto-focus the search input on open — that
        // would pop the soft keyboard over the list the user wants to tap. They
        // can tap the input to search. On desktop (fine pointer) keep the
        // default focus so type-to-filter works immediately.
        onOpenAutoFocus={(e) => {
          if (window.matchMedia("(pointer: coarse)").matches) e.preventDefault();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Switch Worktree</DialogTitle>
          <DialogDescription>Search worktrees by name, repo, or branch</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={true}>
          <CommandInput placeholder="Switch worktree..." value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No worktrees found.</CommandEmpty>
            {sortedWorktrees.map((entry) => {
              const isActive = activeWorktreeId === entry.worktreeId;
              const pinnedNow = isPinned(entry.worktreeId);
              // Read live agent status per row here (not inside the sort memo) so
              // status ticks repaint only the rows, never re-sort the list.
              const agent = statuses.get(entry.worktreeId)?.agent;
              return (
                <CommandItem
                  key={entry.worktreeId}
                  value={`${entry.repoName} ${entry.name} ${entry.branch}`}
                  onSelect={() => handleSelect(entry.worktreeId)}
                  data-testid={`worktree-picker__item--${entry.worktreeId}`}
                  // Coarse pointers (touch) get a 44px-tall row (iOS HIG hit
                  // target) and `touch-manipulation` to drop the tap delay, so
                  // worktrees are easy to select by tap — mirroring the
                  // repo-list rows.
                  className="group touch-manipulation [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:gap-3"
                >
                  {/* Root worktrees get a house icon (the same identity marker
                      as the repo-list root card); an active agent's status
                      dot replaces it via the fallback slot. */}
                  <AgentStatusIndicator
                    agent={agent}
                    isActive={isActive}
                    fallback={
                      entry.isRoot ? (
                        <Home
                          data-testid={`worktree-picker__home-icon--${entry.worktreeId}`}
                          className={`size-3.5 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
                        />
                      ) : undefined
                    }
                  />
                  <WorktreeLabel
                    name={entry.name}
                    repoName={entry.repoName}
                    isActive={isActive}
                    tone="switcher"
                  />
                  <div className="ml-auto flex items-center gap-2">
                    {isActive && (
                      <span className="shrink-0 text-xs text-muted-foreground">current</span>
                    )}
                    <button
                      type="button"
                      aria-label={pinnedNow ? "Unpin worktree" : "Pin worktree"}
                      data-testid={`worktree-picker__pin--${entry.worktreeId}`}
                      // Hover-reveal on fine pointers (mouse); always visible on
                      // coarse pointers (touch has no hover) and sized to a 36px
                      // tap target so it can be pinned/unpinned by tap.
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity text-muted-foreground hover:text-foreground group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:size-9 [@media(pointer:coarse)]:opacity-100"
                      // Pin/unpin is a distinct action — it must never select
                      // the worktree. cmdk fires the row's onSelect from the
                      // item's bubbled `onClick`, so we stopPropagation on every
                      // event that could reach it: pointerdown/mousedown (touch
                      // + mouse activation) and click (the actual select trigger
                      // + keyboard Enter/Space). We toggle once, on click, so a
                      // tap and a keyboard press behave identically.
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        togglePinned(entry.repoName, entry.name, pinnedNow);
                      }}
                    >
                      {pinnedNow ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                    </button>
                  </div>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
