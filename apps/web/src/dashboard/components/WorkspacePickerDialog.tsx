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
import { usePinnedWorkspaces } from "../hooks/use-pinned-workspaces";
import { useProjects } from "../hooks/use-projects";
import { getRecentWorkspaceOrder, recordWorkspaceAccess } from "../lib/recent-workspaces";
import { toWorkspaceId } from "../lib/workspace-id";
import { useDashboardStore } from "../stores/index";
import type { AgentInfo } from "../types";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { WorkspaceLabel } from "./WorkspaceLabel";

interface WorkspaceEntry {
  workspaceId: string;
  projectName: string;
  /** Stable workspace identity/label (see `WorktreeInfo.name`). */
  name: string;
  /** Live git branch — kept for search only. */
  branch: string;
  /**
   * True when this workspace is the project's main checkout (its default-branch
   * worktree, and the project is a git project). Marked with a house icon
   * instead of the branch glyph, mirroring the project-list root card.
   */
  isRoot: boolean;
  agent?: AgentInfo;
}

interface WorkspacePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkspacePickerDialog({ open, onOpenChange }: WorkspacePickerDialogProps) {
  const { projects } = useProjects();
  const capabilities = useCapabilities();
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const statuses = useDashboardStore((s) => s.statuses);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  const { isPinned, toggle: togglePinned } = usePinnedWorkspaces();

  const [query, setQuery] = useState("");

  // Read recent order once when the dialog opens
  const [recentOrder, setRecentOrder] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setRecentOrder(getRecentWorkspaceOrder());
    } else {
      setQuery("");
    }
  }, [open]);

  // Flatten all workspaces and sort strictly by most-recently-accessed. The
  // active workspace floats to the top (it's what the user just left / is on),
  // then everything else follows the recent-access order. Pinned status does
  // NOT affect ordering here — pinning is a sidebar-grouping affordance, so a
  // rarely-touched pinned workspace must not jump above one the user just used.
  const sortedWorkspaces = useMemo(() => {
    const entries: WorkspaceEntry[] = [];
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const workspaceId = toWorkspaceId(project.name, worktree.name);
        entries.push({
          workspaceId,
          projectName: project.name,
          name: worktree.name,
          branch: worktree.branch,
          // A git project's default-branch worktree is its main checkout (the
          // repo root). Plain projects have no root/feature distinction.
          isRoot: project.kind !== "plain" && worktree.name === project.defaultBranch,
          agent: statuses.get(workspaceId)?.agent,
        });
      }
    }

    const orderMap = new Map(recentOrder.map((id, i) => [id, i]));
    entries.sort((a, b) => {
      if (a.workspaceId === activeWorkspaceId) return -1;
      if (b.workspaceId === activeWorkspaceId) return 1;
      const ai = orderMap.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderMap.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

    return entries;
  }, [projects, statuses, recentOrder, activeWorkspaceId]);

  const handleSelect = useCallback(
    (workspaceId: string) => {
      clearNeedsAttention(workspaceId);
      recordWorkspaceAccess(workspaceId);
      const href = capabilities.getWorkspaceHref?.(workspaceId);
      if (href && capabilities.navigate) {
        capabilities.navigate(href);
      } else {
        openWorkspace(workspaceId);
      }
      onOpenChange(false);
    },
    [capabilities, openWorkspace, clearNeedsAttention, onOpenChange],
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
        data-testid="workspace-picker"
        // On touch devices, don't auto-focus the search input on open — that
        // would pop the soft keyboard over the list the user wants to tap. They
        // can tap the input to search. On desktop (fine pointer) keep the
        // default focus so type-to-filter works immediately.
        onOpenAutoFocus={(e) => {
          if (window.matchMedia("(pointer: coarse)").matches) e.preventDefault();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Switch Workspace</DialogTitle>
          <DialogDescription>Search workspaces by name, project, or branch</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={true}>
          <CommandInput placeholder="Switch workspace..." value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No workspaces found.</CommandEmpty>
            {sortedWorkspaces.map((entry) => {
              const isActive = activeWorkspaceId === entry.workspaceId;
              const pinnedNow = isPinned(entry.workspaceId);
              return (
                <CommandItem
                  key={entry.workspaceId}
                  value={`${entry.projectName} ${entry.name} ${entry.branch}`}
                  onSelect={() => handleSelect(entry.workspaceId)}
                  data-testid={`workspace-picker__item--${entry.workspaceId}`}
                  // Coarse pointers (touch) get a 44px-tall row (iOS HIG hit
                  // target) and `touch-manipulation` to drop the tap delay, so
                  // workspaces are easy to select by tap — mirroring the
                  // project-list rows.
                  className="group touch-manipulation [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:gap-3"
                >
                  {/* Root workspaces get a house icon (the same identity marker
                      as the project-list root card); an active agent's status
                      dot replaces it via the fallback slot. */}
                  <AgentStatusIndicator
                    agent={entry.agent}
                    isActive={isActive}
                    fallback={
                      entry.isRoot ? (
                        <Home
                          data-testid={`workspace-picker__home-icon--${entry.workspaceId}`}
                          className={`size-3.5 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
                        />
                      ) : undefined
                    }
                  />
                  <WorkspaceLabel
                    name={entry.name}
                    projectName={entry.projectName}
                    isActive={isActive}
                    tone="switcher"
                  />
                  <div className="ml-auto flex items-center gap-2">
                    {isActive && (
                      <span className="shrink-0 text-xs text-muted-foreground">current</span>
                    )}
                    <button
                      type="button"
                      aria-label={pinnedNow ? "Unpin workspace" : "Pin workspace"}
                      data-testid={`workspace-picker__pin--${entry.workspaceId}`}
                      // Hover-reveal on fine pointers (mouse); always visible on
                      // coarse pointers (touch has no hover) and sized to a 36px
                      // tap target so it can be pinned/unpinned by tap.
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity text-muted-foreground hover:text-foreground group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:size-9 [@media(pointer:coarse)]:opacity-100"
                      // Pin/unpin is a distinct action — it must never select
                      // the workspace. cmdk fires the row's onSelect from the
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
                        togglePinned(entry.projectName, entry.name, pinnedNow);
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
