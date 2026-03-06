import { Clipboard, Ellipsis, FolderOpen, GitBranch, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@band/ui";
import { useCapabilities } from "../context";
import { useDashboardStore } from "../stores/index";
import type { WorkspaceBranchStatus, WorkspaceStatus, WorktreeInfo } from "../types";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { CIStatusIndicator } from "./CIStatusIndicator";
import { DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog";
import { GitStatusIndicator } from "./GitStatusIndicator";

interface Props {
  worktree: WorktreeInfo;
  projectName: string;
  defaultBranch: string;
  status?: WorkspaceStatus;
  branchStatus?: WorkspaceBranchStatus;
  isFocused?: boolean;
}

export function WorkspaceCard({
  worktree,
  projectName,
  defaultBranch,
  status,
  branchStatus,
  isFocused,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const capabilities = useCapabilities();

  useEffect(() => {
    if (isFocused) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);

  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const removeWorkspace = useDashboardStore((s) => s.removeWorkspace);
  const runScript = useDashboardStore((s) => s.runScript);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const workspaceId = `${projectName}-${worktree.branch}`;
  const isActive = activeWorkspaceId === workspaceId;
  const href = capabilities.getWorkspaceHref?.(workspaceId);

  const handleClick = () => {
    if (!href) openWorkspace(workspaceId);
  };

  const className = `flex flex-row items-center justify-between px-3 py-1.5 min-w-0 overflow-hidden cursor-pointer transition-colors hover:bg-accent/50 ${isActive ? "bg-accent/50 border-l-2 border-l-primary" : ""} ${isFocused ? "ring-2 ring-inset ring-ring" : ""} ${href ? "no-underline text-inherit" : ""}`;

  const Container = href ? "a" : "div";
  const containerProps = href
    ? { href, ref: cardRef as React.Ref<HTMLAnchorElement>, className, tabIndex: 0 }
    : { ref: cardRef, className, tabIndex: 0, onClick: handleClick, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") handleClick(); } };

  const ciState = branchStatus?.ci.state;
  const hasUnmergedPR = ciState !== undefined && ciState !== "none" && ciState !== "merged";
  const isDirty = branchStatus?.git.dirty ?? false;
  const hasUnpushedCommits = (branchStatus?.git.ahead ?? 0) > 0;

  const handleDelete = () => {
    if (!hasUnmergedPR && !isDirty && !hasUnpushedCommits) {
      removeWorkspace(projectName, worktree.branch);
    } else {
      setShowDeleteDialog(true);
    }
  };

  const confirmDelete = () => {
    setShowDeleteDialog(false);
    removeWorkspace(projectName, worktree.branch);
  };

  return (
    <Container {...(containerProps as React.HTMLAttributes<HTMLElement>)}>

      <div className="flex flex-1 items-center gap-3 min-w-0 overflow-hidden">
        <GitBranch
          className={`size-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
        />
        <span
          className={`text-xs truncate ${isActive ? "font-semibold text-foreground" : "font-medium"}`}
          style={isActive ? undefined : { color: "oklch(0.7 0 0)" }}
        >
          {worktree.branch}
        </span>
        <AgentStatusBadge agent={status?.agent} />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {branchStatus && <GitStatusIndicator git={branchStatus.git} />}
        {branchStatus && <CIStatusIndicator ci={branchStatus.ci} />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground shrink-0">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            {capabilities.copyPath && (
              <DropdownMenuItem onClick={() => navigator.clipboard.writeText(worktree.path)}>
                <Clipboard />
                Copy path
              </DropdownMenuItem>
            )}
            {capabilities.revealInFinder && (
              <DropdownMenuItem
                onClick={() => capabilities.revealInFinder!(worktree.path)}
              >
                <FolderOpen />
                Open in Finder
              </DropdownMenuItem>
            )}
            {worktree.hasSetup && (
              <DropdownMenuItem onClick={() => runScript(worktree.path, "setup")}>
                <Play />
                Run setup
              </DropdownMenuItem>
            )}
            {worktree.hasTeardown && (
              <DropdownMenuItem onClick={() => runScript(worktree.path, "teardown")}>
                <Square />
                Run teardown
              </DropdownMenuItem>
            )}
            {worktree.branch !== defaultBranch && (
              <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                <Trash2 />
                Delete workspace
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeleteWorkspaceDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={confirmDelete}
        branchName={worktree.branch}
        isUnmerged={hasUnmergedPR}
        isDirty={isDirty}
        hasUnpushedCommits={hasUnpushedCommits}
      />
    </Container>
  );
}
