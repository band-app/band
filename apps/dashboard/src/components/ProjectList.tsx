import { useState } from "react";
import { useDashboardStore } from "@/stores/dashboard-store";
import { WorkspaceCard } from "@/components/WorkspaceCard";
import { NewWorkspaceDialog } from "@/components/NewWorkspaceForm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Ellipsis, Plus, Trash2 } from "lucide-react";

export function ProjectList() {
  const projects = useDashboardStore((s) => s.projects);
  const statuses = useDashboardStore((s) => s.statuses);
  const removeProject = useDashboardStore((s) => s.removeProject);
  const [workspaceDialog, setWorkspaceDialog] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <p className="text-sm mb-1">No projects registered</p>
        <p className="text-xs">
          Click the + button to register a git repository
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {projects.map((project) => (
        <div key={project.name}>
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-base font-semibold">{project.name}</h2>
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
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => removeProject(project.name)}
                  >
                    <Trash2 />
                    Delete project
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

          <div className="flex flex-col gap-1.5">
            {project.worktrees.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-2">
                No workspaces yet
              </p>
            ) : (
              project.worktrees.map((wt) => {
                const wsId = `${project.name}-${wt.branch}`;
                return (
                  <WorkspaceCard
                    key={wt.branch}
                    worktree={wt}
                    projectName={project.name}
                    status={statuses.get(wsId)}
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
