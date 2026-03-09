import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@band/ui";
import { Clipboard, FolderOpen, GitBranch, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCapabilities } from "../context";
import { useRemoveWorkspace } from "../hooks/use-project-mutations";
import { useDashboardStore } from "../stores/index";
import type {
  DeleteDialogInfo,
  WorkspaceBranchStatus,
  WorkspaceStatus,
  WorktreeInfo,
} from "../types";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { CIStatusIndicator } from "./CIStatusIndicator";
import { GitStatusIndicator } from "./GitStatusIndicator";

interface Props {
  worktree: WorktreeInfo;
  projectName: string;
  defaultBranch: string;
  status?: WorkspaceStatus;
  branchStatus?: WorkspaceBranchStatus;
  isFocused?: boolean;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
}

export function WorkspaceCard({
  worktree,
  projectName,
  defaultBranch,
  status,
  branchStatus,
  isFocused,
  onShowDeleteDialog,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const capabilities = useCapabilities();

  useEffect(() => {
    if (isFocused) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);

  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const runScript = useDashboardStore((s) => s.runScript);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const removeWorkspaceMutation = useRemoveWorkspace();

  const workspaceId = `${projectName}-${worktree.branch}`;
  const isActive = activeWorkspaceId === workspaceId;
  const href = capabilities.getWorkspaceHref?.(workspaceId);

  const handleClick = () => {
    if (!href) openWorkspace(workspaceId);
  };

  const className = `flex flex-row items-center justify-between px-3 py-2.5 min-w-0 overflow-hidden cursor-pointer transition-colors hover:bg-accent/50 ${isActive ? "bg-accent/50 border-l-2 border-l-primary" : ""} ${isFocused ? "ring-2 ring-inset ring-ring" : ""} ${href ? "no-underline text-inherit" : ""}`;

  const Container = href ? "a" : "div";
  const containerProps = href
    ? { href, ref: cardRef as React.Ref<HTMLAnchorElement>, className, tabIndex: 0 }
    : {
        ref: cardRef,
        className,
        tabIndex: 0,
        onClick: handleClick,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") handleClick();
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
        <Container {...(containerProps as React.HTMLAttributes<HTMLElement>)}>
          <div className="flex flex-1 items-center gap-3 min-w-0 overflow-hidden">
            <GitBranch
              className={`size-3.5 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
            />
            <span
              className={`text-sm truncate ${isActive ? "font-semibold text-foreground" : "font-medium"}`}
              style={isActive ? undefined : { color: "oklch(0.7 0 0)" }}
            >
              {worktree.branch}
            </span>
            <AgentStatusBadge agent={status?.agent} />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {branchStatus && <GitStatusIndicator git={branchStatus.git} />}
            {branchStatus && <CIStatusIndicator ci={branchStatus.ci} />}
          </div>
        </Container>
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
        {worktree.branch !== defaultBranch && (
          <ContextMenuItem variant="destructive" onClick={handleDelete}>
            <Trash2 />
            Delete workspace
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
