import { useEffect, useRef } from "react";
import { AgentStatusBadge } from "@/components/AgentStatusBadge";
import { GitStatusIndicator } from "@/components/GitStatusIndicator";
import { CIStatusIndicator } from "@/components/CIStatusIndicator";
import {
  useDashboardStore,
  WorktreeInfo,
  WorkspaceStatus,
  WorkspaceBranchStatus,
} from "@/stores/dashboard-store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Clipboard, Ellipsis, FolderOpen, GitBranch, Trash2 } from "lucide-react";

interface Props {
  worktree: WorktreeInfo;
  projectName: string;
  defaultBranch: string;
  status?: WorkspaceStatus;
  branchStatus?: WorkspaceBranchStatus;
  isFocused?: boolean;
}

export function WorkspaceCard({ worktree, projectName, defaultBranch, status, branchStatus, isFocused }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFocused) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const removeWorkspace = useDashboardStore((s) => s.removeWorkspace);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);

  const workspaceId = `${projectName}-${worktree.branch}`;
  const isActive = activeWorkspaceId === workspaceId;

  return (
    <div
      ref={cardRef}
      className={`flex flex-row items-center justify-between px-3 py-1.5 min-w-0 overflow-hidden cursor-pointer transition-colors hover:bg-accent/50 ${isActive ? "bg-accent/50 border-l-2 border-l-primary" : ""} ${isFocused ? "ring-2 ring-inset ring-ring" : ""}`}
      onClick={() => openWorkspace(workspaceId)}
    >
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        <GitBranch className={`size-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
        <span className={`text-xs truncate ${isActive ? "font-semibold text-foreground" : "font-medium"}`} style={isActive ? undefined : { color: "oklch(0.7 0 0)" }}>{worktree.branch}</span>
        <AgentStatusBadge agent={status?.agent} />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {branchStatus && <GitStatusIndicator git={branchStatus.git} />}
        {branchStatus && <CIStatusIndicator ci={branchStatus.ci} />}
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
            onClick={() => navigator.clipboard.writeText(worktree.path)}
          >
            <Clipboard />
            Copy path
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              import("@tauri-apps/api/core").then(({ invoke }) => invoke("reveal_in_finder", { path: worktree.path }));
            }}
          >
            <FolderOpen />
            Open in Finder
          </DropdownMenuItem>
          {worktree.branch !== defaultBranch && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => removeWorkspace(projectName, worktree.branch)}
            >
              <Trash2 />
              Delete workspace
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </div>
  );
}
