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
      <DialogContent className="overflow-hidden p-0 sm:max-w-[520px]" showCloseButton={false}>
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
                  className="group"
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
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                      // onMouseDown + preventDefault + stopPropagation keeps
                      // cmdk's onSelect from firing (which would navigate and
                      // close the dialog).
                      onMouseDown={(e) => {
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
