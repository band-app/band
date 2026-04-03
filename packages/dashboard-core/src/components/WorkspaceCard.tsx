import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clipboard,
  FolderOpen,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { useCapabilities } from "../context";
import { useRemoveWorkspace } from "../hooks/use-project-mutations";
import { toWorkspaceId } from "../lib/workspace-id";
import { useDashboardStore } from "../stores/index";
import type {
  DeleteDialogInfo,
  SetupStatus,
  WorkspaceBranchStatus,
  WorkspaceStatus,
  WorktreeInfo,
} from "../types";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { CIStatusIndicator } from "./CIStatusIndicator";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { SetupStatusIndicator } from "./SetupStatusIndicator";

interface Props {
  worktree: WorktreeInfo;
  projectName: string;
  defaultBranch: string;
  status?: WorkspaceStatus;
  branchStatus?: WorkspaceBranchStatus;
  setupStatus?: SetupStatus;
  isFocused?: boolean;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  editMode?: boolean;
}

export const WorkspaceCard = memo(function WorkspaceCard({
  worktree,
  projectName,
  defaultBranch,
  status,
  branchStatus,
  setupStatus,
  isFocused,
  onShowDeleteDialog,
  editMode,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const capabilities = useCapabilities();

  useEffect(() => {
    if (isFocused) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);

  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  const runScript = useDashboardStore((s) => s.runScript);
  const gitPull = useDashboardStore((s) => s.gitPull);
  const gitPush = useDashboardStore((s) => s.gitPush);
  const removeWorkspaceMutation = useRemoveWorkspace();

  const workspaceId = toWorkspaceId(projectName, worktree.branch);
  const isActive = useDashboardStore((s) => s.activeWorkspaceId === workspaceId);
  const href = capabilities.getWorkspaceHref?.(workspaceId);

  const handleClick = () => {
    clearNeedsAttention(workspaceId);
    if (href && capabilities.navigate) {
      capabilities.navigate(href);
    } else if (!href) {
      openWorkspace(workspaceId);
    }
  };

  const className = `@container group flex flex-row items-center justify-between px-3 py-2.5 min-w-0 overflow-hidden cursor-pointer select-none transition-colors hover:bg-accent/50 ${isActive ? "bg-accent/50 border-l-2 border-l-primary" : ""} ${isFocused ? "ring-2 ring-inset ring-ring" : ""} ${href ? "no-underline text-inherit" : ""}`;

  const containerProps = {
    ref: cardRef,
    className,
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      handleClick();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.stopPropagation();
        handleClick();
      }
    },
  };

  const ciState = branchStatus?.ci.state;
  const hasUnmergedPR = ciState !== undefined && ciState !== "none" && ciState !== "merged";
  const isDirty = branchStatus?.git.dirty ?? false;
  const hasUnpushedCommits = (branchStatus?.git.ahead ?? 0) > 0;

  const handleDelete = () => {
    if (!hasUnmergedPR && !isDirty && !hasUnpushedCommits) {
      removeWorkspaceMutation.mutate({ project: projectName, branch: worktree.branch });
    } else {
      onShowDeleteDialog({
        projectName,
        branch: worktree.branch,
        isUnmerged: hasUnmergedPR,
        isDirty,
        hasUnpushedCommits,
      });
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div {...containerProps}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                <AgentStatusIndicator agent={status?.agent} isActive={isActive} />
                <span
                  className={`text-sm truncate ${isActive ? "font-semibold text-foreground" : "font-medium"}`}
                  style={isActive ? undefined : { color: "oklch(0.7 0 0)" }}
                >
                  {worktree.branch}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">{worktree.branch}</TooltipContent>
          </Tooltip>
          {!editMode && (
            <div className="hidden @[12rem]:flex group-hover:flex items-center gap-2 shrink-0 ml-auto pl-2">
              <SetupStatusIndicator setup={setupStatus} />
              {branchStatus && <GitStatusIndicator git={branchStatus.git} />}
              {branchStatus && <CIStatusIndicator ci={branchStatus.ci} />}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {capabilities.copyPath && (
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(worktree.path)}>
            <Clipboard />
            Copy path
          </ContextMenuItem>
        )}
        {capabilities.revealInFinder && (
          <ContextMenuItem onClick={() => capabilities.revealInFinder!(worktree.path)}>
            <FolderOpen />
            Open in Finder
          </ContextMenuItem>
        )}
        {worktree.hasSetup && (
          <ContextMenuItem onClick={() => runScript(worktree.path, "setup")}>
            <Play />
            Run setup
          </ContextMenuItem>
        )}
        {worktree.hasTeardown && (
          <ContextMenuItem onClick={() => runScript(worktree.path, "teardown")}>
            <Square />
            Run teardown
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => gitPull(projectName, worktree.branch)}>
          <ArrowDownToLine />
          Git pull
        </ContextMenuItem>
        <ContextMenuItem onClick={() => gitPush(projectName, worktree.branch)}>
          <ArrowUpFromLine />
          Git push
        </ContextMenuItem>
        {worktree.branch !== defaultBranch && (
          <ContextMenuItem variant="destructive" onClick={handleDelete}>
            <Trash2 />
            Delete workspace
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});
