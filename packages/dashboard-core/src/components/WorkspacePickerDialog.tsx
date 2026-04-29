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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCapabilities } from "../context";
import { useProjects } from "../hooks/use-projects";
import { getRecentWorkspaceOrder, recordWorkspaceAccess } from "../lib/recent-workspaces";
import { toWorkspaceId } from "../lib/workspace-id";
import { useDashboardStore } from "../stores/index";
import { AgentStatusIndicator } from "./AgentStatusIndicator";

interface WorkspaceEntry {
  workspaceId: string;
  projectName: string;
  branch: string;
  agent?: { status: string } | null;
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

  // Flatten all workspaces and sort by recency
  const sortedWorkspaces = useMemo(() => {
    const entries: WorkspaceEntry[] = [];
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const workspaceId = toWorkspaceId(project.name, worktree.branch);
        entries.push({
          workspaceId,
          projectName: project.name,
          branch: worktree.branch,
          agent: statuses[workspaceId]?.agent ?? worktree.agent,
        });
      }
    }

    const orderMap = new Map(recentOrder.map((id, i) => [id, i]));
    entries.sort((a, b) => {
      const ai = orderMap.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderMap.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

    return entries;
  }, [projects, statuses, recentOrder]);

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
              return (
                <CommandItem
                  key={entry.workspaceId}
                  value={`${entry.projectName} ${entry.branch}`}
                  onSelect={() => handleSelect(entry.workspaceId)}
                >
                  <AgentStatusIndicator agent={entry.agent} />
                  <span className="text-sm font-medium">
                    {entry.projectName}/{entry.branch}
                  </span>
                  {isActive && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">current</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
