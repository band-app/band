import { AgentStatusBadge } from "@/components/AgentStatusBadge";
import {
  useDashboardStore,
  WorktreeInfo,
  WorkspaceStatus,
} from "@/stores/dashboard-store";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Ellipsis, Trash2 } from "lucide-react";

interface Props {
  worktree: WorktreeInfo;
  projectName: string;
  status?: WorkspaceStatus;
}

export function WorkspaceCard({ worktree, projectName, status }: Props) {
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const removeWorkspace = useDashboardStore((s) => s.removeWorkspace);

  const workspaceId = `${projectName}-${worktree.branch}`;

  return (
    <Card
      className="flex-row items-center justify-between px-4 py-2.5 gap-0 rounded-none border-0 shadow-none cursor-pointer transition-colors hover:bg-accent/50"
      onClick={() => openWorkspace(workspaceId)}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-sm font-medium shrink-0">{worktree.branch}</span>
        <AgentStatusBadge agent={status?.agent} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground shrink-0"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => removeWorkspace(projectName, worktree.branch)}
          >
            <Trash2 />
            Delete workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
  );
}
