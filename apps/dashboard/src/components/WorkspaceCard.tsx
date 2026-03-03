import { AgentStatusBadge } from "./AgentStatusBadge";
import {
  useDashboardStore,
  WorktreeInfo,
  WorkspaceStatus,
} from "../stores/dashboard-store";

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
    <div
      className="flex items-center justify-between px-4 py-2.5 rounded-lg cursor-pointer transition-colors bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)]"
      onClick={() => openWorkspace(workspaceId)}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-sm font-medium text-[var(--color-text)] shrink-0">
          {worktree.branch}
        </span>
        <AgentStatusBadge agent={status?.agent} />
      </div>
      <button
        className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors px-2 py-1 shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          removeWorkspace(projectName, worktree.branch);
        }}
        title="Remove worktree"
      >
        ×
      </button>
    </div>
  );
}
