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
import { Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCapabilities } from "../context";
import { usePinnedWorkspaces } from "../hooks/use-pinned-workspaces";
import { useProjects } from "../hooks/use-projects";
import { getRecentWorkspaceOrder, recordWorkspaceAccess } from "../lib/recent-workspaces";
import { toWorkspaceId } from "../lib/workspace-id";
import { useDashboardStore } from "../stores/index";
import type { AgentInfo } from "../types";
import { AgentStatusIndicator } from "./AgentStatusIndicator";

interface WorkspaceEntry {
  workspaceId: string;
  projectName: string;
  branch: string;
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
  const { isPinned, toggle: togglePinned, pinned } = usePinnedWorkspaces();

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

  // Map workspaceId -> rank in pinnedEntries (order = DB insertion order).
  // Used to sort pinned entries deterministically near the top of the list.
  const pinnedRank = useMemo(() => new Map(pinned.map((p, i) => [p.workspaceId, i])), [pinned]);

  // Flatten all workspaces and sort: active first, then pinned (in pin order),
  // then everything else by recency.
  const sortedWorkspaces = useMemo(() => {
    const entries: WorkspaceEntry[] = [];
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const workspaceId = toWorkspaceId(project.name, worktree.branch);
        entries.push({
          workspaceId,
          projectName: project.name,
          branch: worktree.branch,
          agent: statuses.get(workspaceId)?.agent,
        });
      }
    }

    const orderMap = new Map(recentOrder.map((id, i) => [id, i]));
    entries.sort((a, b) => {
      if (a.workspaceId === activeWorkspaceId) return -1;
      if (b.workspaceId === activeWorkspaceId) return 1;
      const ap = pinnedRank.get(a.workspaceId);
      const bp = pinnedRank.get(b.workspaceId);
      if (ap !== undefined && bp === undefined) return -1;
      if (bp !== undefined && ap === undefined) return 1;
      if (ap !== undefined && bp !== undefined) return ap - bp;
      const ai = orderMap.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderMap.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

    return entries;
  }, [projects, statuses, recentOrder, activeWorkspaceId, pinnedRank]);

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
        // No border ("white frame") and the app's floating-surface colour
        // (`bg-popover`, same as dropdowns / context menus) so the picker reads
        // as part of the app rather than a stock modal. `shadow-2xl` + the
        // blurred overlay give it depth without a hard edge.
        className="overflow-hidden border-0 bg-popover p-0 shadow-2xl sm:max-w-[520px]"
        overlayClassName="backdrop-blur-sm"
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
                  value={`${entry.projectName} ${entry.branch}`}
                  onSelect={() => handleSelect(entry.workspaceId)}
                  data-testid={`workspace-picker__item--${entry.workspaceId}`}
                  // Coarse pointers (touch) get a 44px-tall row (iOS HIG hit
                  // target) and `touch-manipulation` to drop the tap delay, so
                  // workspaces are easy to select by tap — mirroring the
                  // project-list rows.
                  className="group touch-manipulation [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:gap-3"
                >
                  <AgentStatusIndicator agent={entry.agent} />
                  <span className="text-sm font-medium">
                    {entry.projectName}/{entry.branch}
                  </span>
                  {pinnedNow && (
                    <Pin className="size-3 -rotate-45 text-muted-foreground shrink-0" />
                  )}
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
                        togglePinned(entry.projectName, entry.branch, pinnedNow);
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
