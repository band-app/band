import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
  Pin,
  PinOff,
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
  ProjectKind,
  SetupStatus,
  WorkspaceBranchStatus,
  WorkspaceStatus,
  WorktreeInfo,
} from "../types";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { CIStatusIndicator } from "./CIStatusIndicator";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { SetupStatusIndicator } from "./SetupStatusIndicator";

// ---------------------------------------------------------------------------
// Recent-user-activation marker (used to suppress auto-scroll on in-list nav)
// ---------------------------------------------------------------------------
//
// The active card auto-scrolls into view ONLY when the navigation came from
// OUTSIDE the project list — direct URL navigation, browser back/forward,
// or the Ctrl+Shift+R workspace picker. When the user clicked a card or pressed
// Enter on a focused card inside the list, the card is already where their
// cursor / keyboard focus is, so the scroll is unwanted.
//
// The two in-list entry points (`WorkspaceCard.handleClick` and
// `ProjectList.selectWorkspace`) mark the workspaceId before navigating.
// The post-navigation `scrollIntoView` effect consumes the marker and bails
// out instead of scrolling. The marker auto-expires after a short window
// so a stale value can't accidentally suppress a legitimate scroll on a
// later URL navigation to the same workspace.
// ---------------------------------------------------------------------------

const RECENT_ACTIVATION_WINDOW_MS = 300;

let recentlyActivatedWorkspaceId: string | null = null;
let recentlyActivatedTimer: ReturnType<typeof setTimeout> | null = null;

export function markRecentActivation(workspaceId: string): void {
  recentlyActivatedWorkspaceId = workspaceId;
  if (recentlyActivatedTimer) clearTimeout(recentlyActivatedTimer);
  recentlyActivatedTimer = setTimeout(() => {
    recentlyActivatedWorkspaceId = null;
    recentlyActivatedTimer = null;
  }, RECENT_ACTIVATION_WINDOW_MS);
}

function consumeRecentActivation(workspaceId: string): boolean {
  if (recentlyActivatedWorkspaceId !== workspaceId) return false;
  recentlyActivatedWorkspaceId = null;
  if (recentlyActivatedTimer) {
    clearTimeout(recentlyActivatedTimer);
    recentlyActivatedTimer = null;
  }
  return true;
}

interface Props {
  worktree: WorktreeInfo;
  projectName: string;
  defaultBranch: string;
  /**
   * Project kind. Defaults to "git" when undefined so older adapters /
   * fixtures keep their current behavior. Plain projects suppress git
   * status indicators, the delete-workspace action, and git pull/push
   * context-menu items — see #427.
   */
  projectKind?: ProjectKind;
  status?: WorkspaceStatus;
  branchStatus?: WorkspaceBranchStatus;
  setupStatus?: SetupStatus;
  isFocused?: boolean;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  /**
   * When true (e.g. inside the Pinned section), render the branch label as
   * `{project}/{branch}` instead of just `{branch}` so the user can tell
   * cards apart when they're mixed across projects.
   */
  showProjectName?: boolean;
  /**
   * Toggle the pinned state for this card's workspace. Passed as a prop
   * (rather than reading from `usePinnedWorkspaces()` inside the card) so
   * each card stays inert to changes in the projects-query cache —
   * otherwise every pin/unpin re-renders every WorkspaceCard on the page.
   */
  onTogglePinned: (project: string, branch: string, currentlyPinned: boolean) => void;
}

export const WorkspaceCard = memo(function WorkspaceCard({
  worktree,
  projectName,
  defaultBranch,
  projectKind,
  status,
  branchStatus,
  setupStatus,
  isFocused,
  onShowDeleteDialog,
  showProjectName,
  onTogglePinned,
}: Props) {
  const isPlain = projectKind === "plain";
  const cardRef = useRef<HTMLDivElement>(null);
  const capabilities = useCapabilities();

  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  const runScript = useDashboardStore((s) => s.runScript);
  const gitPull = useDashboardStore((s) => s.gitPull);
  const gitPush = useDashboardStore((s) => s.gitPush);
  const removeWorkspaceMutation = useRemoveWorkspace();
  const isPinned = worktree.pinned;

  const workspaceId = toWorkspaceId(projectName, worktree.branch);
  const isActive = useDashboardStore((s) => s.activeWorkspaceId === workspaceId);
  const href = capabilities.getWorkspaceHref?.(workspaceId);

  // Scroll this card into view when it becomes the active workspace via
  // OUTSIDE-the-list navigation (direct URL, browser back/forward, Ctrl+Shift+R
  // workspace picker). The in-list paths (click or keyboard Enter) mark
  // the workspaceId via `markRecentActivation` before they navigate, and
  // we consume that marker here to bail out — the card is already where
  // the user's cursor / keyboard focus is, so the scroll would be a jolt.
  //
  // Tied to `isActive` (URL-derived) rather than `isFocused` (keyboard
  // navigation ring) so arrow-key navigation in the list doesn't trigger
  // scroll, only an actual workspace change does.
  useEffect(() => {
    if (!isActive) return;
    if (consumeRecentActivation(workspaceId)) return;
    cardRef.current?.scrollIntoView({ block: "center" });
  }, [isActive, workspaceId]);

  const handleClick = () => {
    clearNeedsAttention(workspaceId);
    markRecentActivation(workspaceId);
    if (href && capabilities.navigate) {
      capabilities.navigate(href);
    } else if (!href) {
      openWorkspace(workspaceId);
    }
  };

  // `py-1` keeps the row compact with a mouse; on touch devices the
  // `(pointer: coarse)` variant bumps it to a 44px-tall hit target (iOS HIG
  // minimum) so the branch row is easy to tap in the list. `touch-manipulation`
  // drops the 300ms double-tap delay so taps register immediately.
  const className = `@container group flex flex-row items-center justify-between pl-3 pr-2 py-1 min-h-9 min-w-0 overflow-hidden cursor-pointer select-none touch-manipulation transition-colors hover:bg-accent/50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-2 ${isActive ? "border-l-2 border-l-primary" : ""} ${isFocused ? "ring-2 ring-inset ring-ring" : ""} ${href ? "no-underline text-inherit" : ""}`;

  const containerProps = {
    ref: cardRef,
    className,
    tabIndex: 0,
    // Semantic markers — let tests, screen readers, and future styling
    // changes target the active card without depending on the Tailwind
    // class string. `aria-current="page"` is the standard ARIA pattern for
    // "currently-active link in a list of related links".
    "data-active": isActive || undefined,
    "aria-current": isActive ? ("page" as const) : undefined,
    // Stable test hook keyed by workspaceId so integration tests can right-
    // click the specific card (issue #508). Branches with `/` in them are
    // collapsed to `-` by `toWorkspaceId` so the attribute value matches
    // the canonical workspace id used everywhere else in the UI.
    "data-testid": `project-list__workspace-card--${workspaceId}`,
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
          {/* `delayDuration` overrides the provider's default 500 ms so
              the tooltip waits long enough that a short mouse pass while
              scanning the sidebar doesn't fire one — but still snappy
              enough to feel responsive when the user actually pauses on
              a card to read the truncated label. */}
          <Tooltip delayDuration={800}>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                <AgentStatusIndicator agent={status?.agent} isActive={isActive} />
                <span
                  className={`text-sm truncate ${isActive ? "font-bold text-foreground" : "font-medium text-muted-foreground"}`}
                >
                  {showProjectName ? `${projectName}/${worktree.branch}` : worktree.branch}
                </span>
              </div>
            </TooltipTrigger>
            {/* Always show the full `project/branch` name in the
                tooltip. The visible label is `truncate`-ellipsised when
                the sidebar is narrow, so spelling out the full thing on
                hover is the one thing a tooltip is actually useful for
                — the worktree's absolute path was clutter (and it
                exposed `$HOME` paths that the user doesn't typically
                care about while scanning the list).
                Anchored to the right of the card (was top) so a long
                project/branch string doesn't cover the next card down
                — fans out into open viewport space instead of
                overlapping siblings. */}
            <TooltipContent side="right">{`${projectName}/${worktree.branch}`}</TooltipContent>
          </Tooltip>
          <div className="hidden @[10rem]:flex group-hover:flex items-center gap-2 shrink-0 ml-auto pl-2">
            <SetupStatusIndicator setup={setupStatus} />
            {/* Plain (non-git) projects have no branch state to surface —
                no dirty/ahead/behind, no CI, no PR — so skip the indicators
                entirely rather than render perpetually-empty badges. */}
            {!isPlain && branchStatus && <GitStatusIndicator git={branchStatus.git} />}
            {!isPlain && branchStatus && <CIStatusIndicator ci={branchStatus.ci} />}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onTogglePinned(projectName, worktree.branch, isPinned)}>
          {isPinned ? <PinOff /> : <Pin />}
          {isPinned ? "Unpin workspace" : "Pin workspace"}
        </ContextMenuItem>
        <ContextMenuSeparator />
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
        {!isPlain && (
          <ContextMenuItem onClick={() => gitPull(projectName, worktree.branch)}>
            <ArrowDownToLine />
            Git pull
          </ContextMenuItem>
        )}
        {!isPlain && (
          <ContextMenuItem onClick={() => gitPush(projectName, worktree.branch)}>
            <ArrowUpFromLine />
            Git push
          </ContextMenuItem>
        )}
        {/* Plain projects have a single implicit workspace; removing it
            would orphan the project, so the user is steered toward
            removing the project itself instead. */}
        {!isPlain && worktree.branch !== defaultBranch && (
          <ContextMenuItem variant="destructive" onClick={handleDelete}>
            <Trash2 />
            Delete workspace
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});
