import { Clipboard, Ellipsis, FolderOpen, ListMinus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NewWorkspaceDialog } from "@/components/NewWorkspaceForm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceCard } from "@/components/WorkspaceCard";
import { useDashboardStore } from "@/stores/dashboard-store";

export function ProjectList() {
  const projects = useDashboardStore((s) => s.projects);
  const statuses = useDashboardStore((s) => s.statuses);
  const branchStatuses = useDashboardStore((s) => s.branchStatuses);
  const removeProject = useDashboardStore((s) => s.removeProject);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const [workspaceDialog, setWorkspaceDialog] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);

  const allWorkspaceIds = useMemo(
    () =>
      projects.flatMap((project) => project.worktrees.map((wt) => `${project.name}-${wt.branch}`)),
    [projects],
  );

  useEffect(() => {
    if (activeWorkspaceId) {
      const idx = allWorkspaceIds.indexOf(activeWorkspaceId);
      setFocusedIndex(idx);
    } else {
      setFocusedIndex(-1);
    }
  }, [activeWorkspaceId, allWorkspaceIds]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (allWorkspaceIds.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev < allWorkspaceIds.length - 1 ? prev + 1 : prev));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else if (e.key === "Enter") {
      if (focusedIndex >= 0 && focusedIndex < allWorkspaceIds.length) {
        openWorkspace(allWorkspaceIds[focusedIndex]);
      }
    }
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-lg mb-2">No projects registered</p>
        <p className="text-sm">Click the + button to register a git repository</p>
      </div>
    );
  }

  let workspaceIndex = 0;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex flex-col gap-2 outline-none min-w-0"
    >
      {projects.map((project, index) => (
        <div key={project.name} className="min-w-0">
          {index > 0 && <hr className="border-border mb-2" />}
          <div className="flex items-center justify-between mb-1 px-1">
            <div className="flex items-center gap-2 min-w-0">
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground truncate">{project.name}</h2>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setWorkspaceDialog(project.name)}
                  >
                    <Plus />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add workspace</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="text-muted-foreground">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => navigator.clipboard.writeText(project.path)}>
                    <Clipboard />
                    Copy path
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      import("@tauri-apps/api/core").then(({ invoke }) =>
                        invoke("reveal_in_finder", { path: project.path }),
                      );
                    }}
                  >
                    <FolderOpen />
                    Open in Finder
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => removeProject(project.name)}>
                    <ListMinus />
                    Remove from list
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <NewWorkspaceDialog
            projectName={project.name}
            open={workspaceDialog === project.name}
            onOpenChange={(open) => setWorkspaceDialog(open ? project.name : null)}
          />

          <div className="flex flex-col gap-0.5 overflow-hidden">
            {project.worktrees.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-2">No workspaces yet</p>
            ) : (
              project.worktrees.map((wt) => {
                const wsId = `${project.name}-${wt.branch}`;
                const currentIndex = workspaceIndex++;
                return (
                  <WorkspaceCard
                    key={wt.branch}
                    worktree={wt}
                    projectName={project.name}
                    defaultBranch={project.defaultBranch}
                    status={statuses.get(wsId)}
                    branchStatus={branchStatuses.get(wsId)}
                    isFocused={currentIndex === focusedIndex}
                  />
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
