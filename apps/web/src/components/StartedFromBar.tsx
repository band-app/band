import { CornerUpLeft } from "lucide-react";
import { toWorktreeId, useCapabilities, useRepos } from "@/dashboard";
import { readCenterTabs, writeCenterTabs } from "../lib/center-tabs";
import { getWorktreeDockviewApi } from "./WorktreeCenterDockview";

/**
 * "Started from <repo · branch>" above a worktree that was started from another one. It opens the
 * origin worktree on the chat (or terminal) that started the work. Renders nothing for top-level
 * work.
 */
export function StartedFromBar({ worktreeId }: { worktreeId: string }) {
  const { repos } = useRepos();
  const capabilities = useCapabilities();
  const origin = repos
    .flatMap((r) => r.worktrees.map((wt) => ({ repo: r, wt })))
    .find(({ repo, wt }) => toWorktreeId(repo.name, wt.name, wt.hostId) === worktreeId)?.wt.origin;
  if (!origin) return null;

  if (origin.removed || !origin.repo) {
    return (
      <div
        data-testid="started-from"
        data-removed="true"
        className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1 text-[12px] text-muted-foreground"
      >
        <CornerUpLeft className="size-3.5" />
        Started from a worktree that was removed
      </div>
    );
  }

  const open = () => {
    const targetId = origin.chatId ?? origin.terminalId;
    if (targetId) {
      const tabs = readCenterTabs(origin.worktreeId);
      if (tabs?.tabs.some((t) => t.id === targetId)) {
        writeCenterTabs(origin.worktreeId, { ...tabs, active: targetId });
      }
      // The origin's dockview, when it is mounted, ignores this device's own write: activate directly.
      getWorktreeDockviewApi(origin.worktreeId)?.getPanel(targetId)?.api.setActive();
    }
    const href = capabilities.getWorktreeHref?.(origin.worktreeId);
    if (href && capabilities.navigate) capabilities.navigate(href);
  };

  return (
    <div
      data-testid="started-from"
      className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1 text-[12px] text-muted-foreground"
    >
      <CornerUpLeft className="size-3.5" />
      <span>Started from</span>
      <button
        type="button"
        data-testid="started-from__link"
        data-origin-worktree={origin.worktreeId}
        onClick={open}
        className="truncate font-medium text-foreground underline-offset-2 hover:underline"
      >
        {origin.repo} · {origin.branch}
      </button>
    </div>
  );
}
