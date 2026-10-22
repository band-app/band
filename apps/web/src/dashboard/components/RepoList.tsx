import { originDescendants } from "@band-app/shared/sidebar-tree";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDndContext,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Clipboard,
  Folder,
  FolderOpen,
  GitBranch,
  ListMinus,
  MoreVertical,
  Pin,
  Plus,
} from "lucide-react";
import {
  type ElementType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { trpc } from "../../lib/trpc-client";
import { useAdapter, useCapabilities } from "../context";
import {
  GROUPS_COLLAPSE_KEY,
  PINNED_COLLAPSE_KEY,
  PINNED_SECTION_ID,
  REPOS_COLLAPSE_KEY,
  UNGROUPED_KEY,
  useCollapseState,
} from "../hooks/use-collapse-state";
import { useGroupMutations, useGroups } from "../hooks/use-groups";
import { useHostRequests } from "../hooks/use-host-requests";
import { usePinnedWorktrees } from "../hooks/use-pinned-worktrees";
import {
  usePromoteRepoToGit,
  useRemoveRepo,
  useRemoveWorktree,
  useReorderRepos,
  useReorderWorktrees,
} from "../hooks/use-repo-mutations";
import { useRepos } from "../hooks/use-repos";
import {
  type DropPlan,
  type DropZone,
  moveRefusal,
  planHostViewDrop,
  planOriginDrop,
  planPinDrop,
  planRepoViewDrop,
  zoneAt,
} from "../lib/sidebar-drop";
import {
  buildGroupRows,
  buildHostRows,
  buildOriginRows,
  buildOriginTree,
  buildPinnedRows,
  buildPinnedTree,
  entriesOf,
  HOST_COLLAPSE_KEY,
  type HostInfoLite,
  hostIdOf,
  hostLabel,
  navigableIds,
  ORIGIN_COLLAPSE_KEY,
  repoSpansHosts,
  sortRepoWorktrees,
  useGroupBy,
  type WorktreeEntry,
  withoutPinned,
} from "../lib/sidebar-grouping";
import { isWorktreeDeleting } from "../stores/dashboard-store";
import { useDashboardStore, useRawDashboardStore } from "../stores/index";
import type {
  DeleteDialogInfo,
  GroupDefinition,
  RepoInfo,
  SetupStatus,
  WorktreeBranchStatus,
  WorktreeStatus,
} from "../types";
import { AgentStatusIndicator, isActiveAgentStatus } from "./AgentStatusIndicator";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import {
  DeleteGroupDialog,
  GroupNameDialog,
  MoveChildrenDialog,
  PickRepoDialog,
} from "./GroupDialogs";
import { GroupedWorktrees, WorktreeRowView } from "./GroupedWorktrees";
import { MainMissingRow } from "./MainMissingRow";
import { MoveWorktreeDialog } from "./MoveWorktreeDialog";
import { NewWorktreeDialog } from "./NewWorktreeForm";
import { PromoteToGitDialog } from "./PromoteToGitDialog";
import { ProvisioningWorktreeCard } from "./ProvisioningWorktreeCard";
import { RepoAvatar } from "./RepoAvatar";
import { DragRow, DropIndicatorContext } from "./SidebarDnd";
import { useIsAdmin } from "./settings/DevicesSettings";
import { markRecentActivation, WorktreeCard } from "./WorktreeCard";

/**
 * Wraps a collapsible section's body so expand/collapse animates smoothly.
 *
 * Uses the CSS grid-rows `[0fr] → [1fr]` trick: the outer grid animates its
 * single row track between 0 and its content height, and the inner
 * `overflow-hidden` child clips the content while the track shrinks. This
 * animates height without measuring it in JS (no `max-height` guesswork).
 *
 * The body stays mounted in both states — the transition needs the content
 * present at both ends to animate (unmounting the content on collapse would
 * make expand "pop" open with no starting height to animate from). `inert`
 * takes the hidden subtree out of the tab order and blocks pointer/focus so a
 * collapsed section behaves as if it weren't there (keyboard worktree nav
 * already excludes collapsed rows via `allWorktreeIds`). Keeping a sidebar's
 * bounded set of cards mounted is cheap — they're memoized and only re-render
 * when their own store slice changes.
 */
function CollapsibleSection({
  collapsed,
  className,
  children,
}: {
  collapsed: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
        collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
      }`}
    >
      <div className={`overflow-hidden ${className ?? ""}`} inert={collapsed}>
        {children}
      </div>
    </div>
  );
}

interface SortableRepoProps {
  repo: RepoInfo;
  statuses: Map<string, WorktreeStatus>;
  branchStatuses: Map<string, WorktreeBranchStatus>;
  setupStatuses: Map<string, SetupStatus>;
  removeRepo: (name: string) => void;
  /** Opens the promote-to-git confirmation dialog for the given repo. */
  onPromoteToGit: (name: string) => void;
  setWorktreeDialog: (name: string | null) => void;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  focusedIndex: number;
  worktreeIndexStart: number;
  collapsed: boolean;
  onToggleCollapse: (name: string) => void;
  /**
   * True when the repo had at least one worktree before pinned ones were
   * filtered out. Used to suppress the misleading "No worktrees yet" message
   * when all worktrees are pinned and shown in the Pinned section instead.
   */
  hasPinnedSiblings?: boolean;
  onTogglePinned: (repo: string, name: string, currentlyPinned: boolean) => void;
  /** Known hosts, to name the host tag of a repo that spans several. */
  hosts: HostInfoLite[];
}

function SortableRepo({
  repo,
  statuses,
  branchStatuses,
  setupStatuses,
  removeRepo,
  onPromoteToGit,
  setWorktreeDialog,
  onShowDeleteDialog,
  focusedIndex,
  worktreeIndexStart,
  collapsed,
  onToggleCollapse,
  hasPinnedSiblings,
  onTogglePinned,
  hosts,
}: SortableRepoProps) {
  const isPlain = repo.kind === "plain";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: repo.name,
  });
  const capabilities = useCapabilities();
  // `adapter.promoteRepoToGit` is optional on the DashboardAdapter
  // interface — only the web adapter implements it today. Hide the menu
  // item when the active adapter lacks the method so the user can't click
  // through to a runtime error (`use-repo-mutations` rejects with a
  // friendly message, but hiding the affordance is cleaner).
  const adapter = useAdapter();
  const canPromoteToGit = typeof adapter.promoteRepoToGit === "function";
  // `active` is the currently-dragged item (or null when nothing is being
  // dragged). We only honour dnd-kit's `transition` while a drag is in
  // progress: that keeps the smooth slide-out-of-the-way animation while
  // dragging, but on drop the transition disappears so items snap to their
  // optimistic new positions instead of animating from old → new (which
  // looks like the list "shifting" after the drop).
  const { active } = useDndContext();

  const style = {
    transform: CSS.Translate.toString(transform),
    transition: active ? transition : undefined,
    opacity: isDragging ? 0.5 : undefined,
  };

  // Plain repos flatten: the repo header IS the implicit worktree's
  // card. There's no nested "main" row, no collapse chevron, no "+" Add
  // worktree button, and crucially no pinning (the worktree is already
  // at the repo level — there's nothing to "pull up to the top"). See
  // #427.
  const provisioning = useHostRequests().filter((r) => r.repo === repo.name);
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  // Plain repos are guaranteed to have exactly one worktree (the
  // implicit `main` synthesized by repos.add and re-synthesized by
  // `reconcileKindForRepo` on any git → plain flip). Read
  // `worktrees[0].name` directly rather than `?.name ?? "main"`;
  // the optional chain would mask a real state-corruption bug.
  const plainName = isPlain ? repo.worktrees[0].name : "";
  const plainWorktreeId = isPlain
    ? toWorktreeId(repo.name, plainName, repo.worktrees[0].hostId)
    : "";
  const plainIsActive = useDashboardStore((s) => isPlain && s.activeWorktreeId === plainWorktreeId);
  const plainHref = isPlain ? capabilities.getWorktreeHref?.(plainWorktreeId) : undefined;
  const plainAgent = isPlain ? statuses.get(plainWorktreeId)?.agent : undefined;
  const plainIsFocused = isPlain && worktreeIndexStart === focusedIndex;

  // For git repos: is the currently-active worktree one of this repo's
  // branches? Plain repos already surface this via `plainIsActive`. Git
  // headers had no active treatment, so the user couldn't tell which repo
  // the open worktree belonged to once scrolled away from its card — this
  // tints the header (and its folder icon) to close that gap.
  const activeWorktreeId = useDashboardStore((s) => s.activeWorktreeId);
  // Memoized: every Zustand update re-renders this row, and the `.some(...)`
  // walk is O(worktrees) — recompute only when the inputs actually change.
  const gitHeaderIsActive = useMemo(
    () =>
      !isPlain &&
      repo.worktrees.some((wt) => toWorktreeId(repo.name, wt.name, wt.hostId) === activeWorktreeId),
    [isPlain, repo.worktrees, repo.name, activeWorktreeId],
  );

  // Single onClick / onKeyDown for the plain-repo header (mirrors the
  // navigate-or-open dance WorktreeCard does). For git repos the
  // header onClick toggles collapse — branched at the call site.
  const handlePlainOpen = () => {
    clearNeedsAttention(plainWorktreeId);
    if (plainHref && capabilities.navigate) {
      capabilities.navigate(plainHref);
    } else if (!plainHref) {
      openWorktree(plainWorktreeId);
    }
  };

  let worktreeIndex = worktreeIndexStart;

  // Header className. Both kinds keep the repo-level indent (`pl-1`)
  // so plain repos read as standalone repos, not as nested
  // worktrees under the repo above them. Plain repos also gain
  // the WorktreeCard hover/active/focus treatment because the header
  // itself is clickable — but the inner text styling stays repo-bold
  // (see the `<h2>` block below). `py-1.5` gives a taller hit target
  // than a worktree card (`py-1`) so the row reads as a repo, not
  // a nested worktree.
  // On touch devices (`pointer: coarse`) the row grows to a 44px-tall hit
  // target (iOS HIG minimum) so repos are easy to tap in the list; with a
  // mouse the row stays compact. `touch-pan-y` (not `touch-manipulation`) is
  // kept because dnd-kit needs vertical panning to scroll the list mid-drag.
  const headerClassName = isPlain
    ? `group flex items-center justify-between mb-0.5 rounded-md pl-1 pr-1 py-1.5 min-w-0 overflow-hidden cursor-pointer select-none touch-pan-y transition-colors hover:bg-accent/50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-2.5 ${
        plainIsActive ? "bg-primary/15 hover:bg-primary/15" : plainIsFocused ? "bg-accent" : ""
      }`
    : `group flex items-center justify-between mb-0.5 pl-1 pr-0 rounded select-none touch-pan-y transition-colors hover:bg-accent/50 [@media(pointer:coarse)]:min-h-11`;

  // The repo action list is rendered in two places — the right-click
  // context menu and the header's "⋮" dropdown — so it's defined once here and
  // parameterised by the menu primitive set (Context* or Dropdown*), which
  // share the same Item shape. Keeps the two
  // menus from drifting.
  const renderMenuItems = (menu: { Item: ElementType }) => {
    const { Item } = menu;
    return (
      <>
        {/* Git repos only: `git worktree add`. Mirrors the header's
            hover-revealed "+" button, kept first as the primary action. */}
        {!isPlain && (
          <Item
            data-testid="repo-list__action--add-worktree"
            onClick={() => setWorktreeDialog(repo.name)}
          >
            <Plus />
            Add worktree
          </Item>
        )}
        {isPlain && canPromoteToGit && (
          <Item onClick={() => onPromoteToGit(repo.name)}>
            <GitBranch />
            Promote to git…
          </Item>
        )}
        {capabilities.copyPath && (
          <Item onClick={() => navigator.clipboard.writeText(repo.path)}>
            <Clipboard />
            Copy path
          </Item>
        )}
        {capabilities.revealInFinder && (
          <Item onClick={() => capabilities.revealInFinder!(repo.path)}>
            <FolderOpen />
            Open in Finder
          </Item>
        )}
        <Item onClick={() => removeRepo(repo.name)}>
          <ListMinus />
          Remove from list
        </Item>
      </>
    );
  };

  return (
    <div ref={setNodeRef} style={style} className="min-w-0 px-2">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* The header is a click/tap target on both desktop and mobile.
              For git repos it toggles collapse; for plain repos it
              opens the implicit worktree (the repo IS the worktree).
              Keyboard nav lives at the worktree-card level for git
              repos; for plain repos the same role moves up here. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the container-level handler on the RepoList (see "KEYBOARD NAVIGATION — READ BEFORE MODIFYING" below) */}
          <div
            className={headerClassName}
            data-testid={`repo-list__repo-header--${repo.name}`}
            onClick={() => (isPlain ? handlePlainOpen() : onToggleCollapse(repo.name))}
          >
            {/* Drag listeners live on the title (folder icon + repo name)
                so the repo name itself is the drag handle. The 8px
                MouseSensor / 250ms TouchSensor thresholds mean a still
                click/tap bubbles up to the outer onClick without starting
                a drag. */}
            <div
              className="flex items-center gap-2 min-w-0 cursor-grab"
              {...attributes}
              {...listeners}
            >
              {isPlain ? (
                // Plain repo: agent-status dot when the agent is
                // working / needs attention, otherwise a repo-sized
                // (size-4) Folder icon. Inlined rather than routing
                // through AgentStatusIndicator's idle dot so the idle
                // icon can match a git repo's folder size — the faint dot
                // would make plain headers read as nested worktree cards
                // (see #427 review).
                plainAgent && isActiveAgentStatus(plainAgent.status) ? (
                  <AgentStatusIndicator
                    agent={plainAgent}
                    tabStatuses={statuses.get(plainWorktreeId)?.tabStatuses}
                  />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )
              ) : (
                // Git repo: the GitHub owner's avatar when `origin` is
                // on GitHub, else the open/closed folder.
                <RepoAvatar
                  avatar={repo.avatar}
                  className="size-4"
                  testId={`repo-list__repo-avatar--${repo.name}`}
                  fallback={
                    collapsed ? (
                      <Folder
                        data-testid={`repo-list__repo-folder--${repo.name}`}
                        className={`size-4 shrink-0 ${gitHeaderIsActive ? "text-primary" : "text-muted-foreground"}`}
                      />
                    ) : (
                      <FolderOpen
                        data-testid={`repo-list__repo-folder--${repo.name}`}
                        className={`size-4 shrink-0 ${gitHeaderIsActive ? "text-primary" : "text-muted-foreground"}`}
                      />
                    )
                  }
                />
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Same repo-bold treatment regardless of kind so a
                      plain repo reads as a top-level repo rather
                      than a nested branch row. Active plain repos
                      bump to full-foreground for the same emphasis a
                      WorktreeCard would get. */}
                  <h2
                    className={`text-[13px] truncate ${
                      (isPlain && plainIsActive) || gitHeaderIsActive
                        ? "font-bold text-foreground"
                        : "font-semibold text-foreground/90"
                    }`}
                  >
                    {repo.name}
                  </h2>
                </TooltipTrigger>
                {/* Anchored to the right so a long repo name doesn't
                    cover the row above — matches the `side="right"`
                    treatment on `WorktreeCard`'s label tooltip. */}
                <TooltipContent side="right">{repo.name}</TooltipContent>
              </Tooltip>
            </div>
            {/* The "+" and "⋮" buttons are revealed on hover (or keyboard
                focus) to keep the header uncluttered while scanning the list;
                the same actions live in the right-click / long-press context
                menu below. `opacity-0` (not `hidden`) reserves the space so the
                row doesn't reflow on hover. On touch devices there's no hover
                and no room to spare, so the cluster is hidden entirely — the
                actions are reached via long-press instead. */}
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:hidden">
              {/* "⋮" opens the same action list as right-click, so the menu is
                  reachable with a plain left click (and on touch, where there's
                  no right-click). Sits to the left of the "+" quick action. */}
              {!isPlain && (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Repo actions"
                          data-testid={`repo-list__repo-menu-trigger--${repo.name}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>More actions</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    {renderMenuItems({
                      Item: DropdownMenuItem,
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {/* Plain (non-git) repos have a single implicit worktree
                  and don't support `git worktree add`, so the "+" Add
                  worktree button is hidden — see #427. The server also
                  rejects `worktrees.create` as a backstop. */}
              {!isPlain && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setWorktreeDialog(repo.name);
                      }}
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add worktree</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {renderMenuItems({
            Item: ContextMenuItem,
          })}
        </ContextMenuContent>
      </ContextMenu>

      {/* Nested worktrees section — only meaningful for git repos.
          Plain repos are flat: the header above IS the worktree.
          `ml-3` indents the branch list so the worktrees read as children of
          the repo header above, not as sibling rows. The indentation alone
          (no divider rail) conveys the hierarchy, keeping the list uncluttered. */}
      {!isPlain && (
        <CollapsibleSection collapsed={collapsed} className="flex flex-col gap-0.5 ml-3">
          {provisioning.map((request) => (
            <ProvisioningWorktreeCard key={request.id} request={request} />
          ))}
          <MainMissingRow repo={repo} hosts={hosts} />
          {repo.worktrees.length === 0 ? (
            hasPinnedSiblings || provisioning.length > 0 ? null : (
              <p className="text-[13px] text-foreground/60 px-4 py-2">No worktrees yet</p>
            )
          ) : (
            repo.worktrees.map((wt) => {
              const wsId = toWorktreeId(repo.name, wt.name, wt.hostId);
              const currentIndex = worktreeIndex++;
              return (
                // Keyed by name, not id: a move changes the id, and a remount would drop the
                // open "Open on another host" dialog before it shows the result.
                <DragRow
                  key={wt.name}
                  dndId={`wt:${wsId}`}
                  data={{
                    kind: "wt",
                    worktreeId: wsId,
                    repoName: repo.name,
                    hostId: hostIdOf(wt),
                  }}
                >
                  <WorktreeCard
                    worktree={wt}
                    repoName={repo.name}
                    defaultBranch={repo.defaultBranch}
                    repoKind={repo.kind}
                    status={statuses.get(wsId)}
                    branchStatus={branchStatuses.get(wsId)}
                    setupStatus={setupStatuses.get(wsId)}
                    isFocused={!collapsed && currentIndex === focusedIndex}
                    onShowDeleteDialog={onShowDeleteDialog}
                    onTogglePinned={onTogglePinned}
                    hostTag={repoSpansHosts(repo) ? hostLabel(hostIdOf(wt), hosts) : undefined}
                    allowedHostIds={repo.allowedHostIds}
                  />
                </DragRow>
              );
            })
          )}
        </CollapsibleSection>
      )}
    </div>
  );
}

function findWorktree(
  repos: RepoInfo[],
  worktreeId: string,
): { wt: RepoInfo["worktrees"][number]; repo: RepoInfo } | undefined {
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      if (toWorktreeId(repo.name, wt.name, wt.hostId) === worktreeId) return { wt, repo };
    }
  }
  return undefined;
}

interface RepoListProps {
  groupFilter: string | null;
}

export function RepoList({ groupFilter }: RepoListProps) {
  const { repos } = useRepos();
  const groups = useGroups();
  const groupMutations = useGroupMutations();
  const statuses = useDashboardStore((s) => s.statuses);
  const branchStatuses = useDashboardStore((s) => s.branchStatuses);
  const setupStatuses = useDashboardStore((s) => s.setupStatuses);
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const activeWorktreeId = useDashboardStore((s) => s.activeWorktreeId);

  const removeRepoMutation = useRemoveRepo();
  const reorderReposMutation = useReorderRepos();
  const reorderWorktreesMutation = useReorderWorktrees();
  const isAdmin = useIsAdmin();
  const promoteRepoToGitMutation = usePromoteRepoToGit();
  const removeWorktreeMutation = useRemoveWorktree();

  const [worktreeDialog, setWorktreeDialogRepo] = useState<string | null>(null);
  // The group a worktree started from a group header joins. Undefined for the repo menu's "+",
  // which leaves the choice to the group filter.
  const [worktreeDialogGroup, setWorktreeDialogGroup] = useState<string | null | undefined>();
  const setWorktreeDialog = useCallback((repo: string | null) => {
    setWorktreeDialogRepo(repo);
    if (repo === null) setWorktreeDialogGroup(undefined);
  }, []);
  /** Group header "+": the group whose repo is being picked. */
  const [pickingRepoFor, setPickingRepoFor] = useState<{ groupId: string | null } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogInfo | null>(null);
  /** Repo name whose "Promote to git" confirmation dialog is open. */
  const [promoteDialog, setPromoteDialog] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const rawStore = useRawDashboardStore();
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeWorktreeDrag, setActiveWorktreeDrag] = useState<WorktreeEntry | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    overId: string | null;
    zone: DropZone | null;
  }>({ overId: null, zone: null });
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ entry: WorktreeEntry; toHostId: string } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const keyboardNavRef = useRef(false);

  const repoCollapse = useCollapseState(REPOS_COLLAPSE_KEY);
  const groupCollapse = useCollapseState(GROUPS_COLLAPSE_KEY);
  const pinnedCollapse = useCollapseState(PINNED_COLLAPSE_KEY);
  const originCollapse = useCollapseState(ORIGIN_COLLAPSE_KEY);
  const hostCollapse = useCollapseState(HOST_COLLAPSE_KEY);
  const [chosenView] = useGroupBy();
  // With no group defined the Groups view would be one "Ungrouped" list, so the sidebar keeps
  // listing worktrees under their repos until the first group exists.
  const groupBy = chosenView === "groups" && groups.length === 0 ? "repo" : chosenView;
  const grouped = groupBy !== "repo";
  const [renamingGroup, setRenamingGroup] = useState<GroupDefinition | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<GroupDefinition | null>(null);
  const [childrenPrompt, setChildrenPrompt] = useState<{
    entry: WorktreeEntry;
    group: GroupDefinition | null;
    childCount: number;
  } | null>(null);
  const hostsQuery = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.workers.list.query()).hosts,
  });
  const { toggle: togglePinned } = usePinnedWorktrees();

  // Worktrees in the order the user dragged them to, and the pins with their subtrees. The group
  // filter applies to pins too: a pin shows only when it is in the selected group, and its
  // children follow the same rule.
  const sortedRepos = useMemo(() => sortRepoWorktrees(repos), [repos]);
  const visibleRepos = useMemo(
    () =>
      groupFilter
        ? sortedRepos
            .map((r) => ({
              ...r,
              worktrees: r.worktrees.filter((wt) => wt.groupId === groupFilter),
            }))
            .filter((r) => r.worktrees.length > 0)
        : sortedRepos,
    [sortedRepos, groupFilter],
  );
  const pinnedTree = useMemo(() => buildPinnedTree(visibleRepos), [visibleRepos]);
  const pinnedRows = useMemo(
    () => buildPinnedRows(pinnedTree, originCollapse.isCollapsed),
    [pinnedTree, originCollapse],
  );

  // Two sensors so reorder works without an explicit "edit" toggle:
  //  • MouseSensor — desktop pointers can drag immediately; an 8px distance
  //    threshold avoids hijacking ordinary clicks on the repo header.
  //  • TouchSensor — touch devices require a long-press (250ms) before drag
  //    activates so taps and scrolling still work normally on mobile.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  // The Pinned section shows each pin and everything started from it, so the regular tree leaves
  // them out. `reposWithPinned` lets SortableRepo hide "No worktrees yet" for a repo that only
  // looks empty because its worktrees are pinned. Plain repos are flat and have no pins.
  const { displayRepos, reposWithPinned } = useMemo(() => {
    const result = withoutPinned(visibleRepos, pinnedTree);
    return { displayRepos: result.repos, reposWithPinned: result.reposWithPinned };
  }, [visibleRepos, pinnedTree]);

  const pinnedSectionCollapsed = pinnedCollapse.isCollapsed(PINNED_SECTION_ID);
  const showPinnedSection = pinnedTree.pins.length > 0;
  const pinnedNavIds = useMemo(
    () =>
      showPinnedSection && !pinnedSectionCollapsed ? pinnedRows.map((r) => r.entry.worktreeId) : [],
    [showPinnedSection, pinnedSectionCollapsed, pinnedRows],
  );
  const pinnedNavCount = pinnedNavIds.length;

  // The Groups, Origin and Host views list every worktree the group filter lets through, except
  // the ones the Pinned section shows, in one flat list of rows.
  const groupedRepos = useMemo(
    () => withoutPinned(visibleRepos, pinnedTree).repos,
    [visibleRepos, pinnedTree],
  );
  const groupedRows = useMemo(() => {
    if (groupBy === "groups") {
      return buildGroupRows({
        repos: groupedRepos,
        allRepos: sortedRepos,
        groups,
        filter: groupFilter,
        isGroupCollapsed: groupCollapse.isCollapsed,
        isOriginCollapsed: originCollapse.isCollapsed,
      });
    }
    if (groupBy === "origin") return buildOriginRows(groupedRepos, originCollapse.isCollapsed);
    if (groupBy === "host")
      return buildHostRows(groupedRepos, hostsQuery.data ?? [], hostCollapse.isCollapsed);
    return [];
  }, [
    groupBy,
    groupedRepos,
    sortedRepos,
    groups,
    groupFilter,
    groupCollapse,
    hostsQuery.data,
    originCollapse,
    hostCollapse,
  ]);
  const groupedEntries = useMemo(() => entriesOf(groupedRepos), [groupedRepos]);
  const originTree = useMemo(() => buildOriginTree(groupedEntries), [groupedEntries]);

  // Only count worktrees that are actually rendered: collapsed repos and groups hide their
  // worktrees entirely, and keyboard arrow navigation must skip over them so focus never lands on
  // something the user can't see. Pinned worktrees are always at the top of the list, then the
  // regular tree follows.
  const allWorktreeIds = useMemo(() => {
    if (grouped) return [...pinnedNavIds, ...navigableIds(groupedRows)];
    const rest = displayRepos.flatMap((p) => {
      if (repoCollapse.isCollapsed(p.name)) return [];
      return p.worktrees.map((wt) => toWorktreeId(p.name, wt.name, wt.hostId));
    });
    return [...pinnedNavIds, ...rest];
  }, [grouped, groupedRows, displayRepos, repoCollapse, pinnedNavIds]);

  const worktreeIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    // Reserve slots [0..pinnedNavCount) for pinned worktrees so per-repo
    // worktreeIndexStart values align with allWorktreeIds.
    let index = pinnedNavCount;
    for (const repo of displayRepos) {
      map.set(repo.name, index);
      if (!repoCollapse.isCollapsed(repo.name)) {
        index += repo.worktrees.length;
      }
    }
    return map;
  }, [displayRepos, repoCollapse, pinnedNavCount]);

  useEffect(() => {
    if (keyboardNavRef.current) return;
    if (activeWorktreeId) {
      const idx = allWorktreeIds.indexOf(activeWorktreeId);
      setFocusedIndex(idx);
    } else {
      setFocusedIndex(-1);
    }
  }, [activeWorktreeId, allWorktreeIds]);

  // Reveal the active worktree in the tree by auto-expanding the repo
  // and group it belongs to. This should run ONLY when
  // activeWorktreeId changes — i.e. when the user switches worktrees via
  // the ⌘K picker, URL nav, notifications, etc. After the initial
  // reveal we deliberately leave the collapse state alone so the user can
  // collapse the ancestors of the active worktree (via the "Collapse all"
  // toolbar button or by clicking a header) without this effect fighting
  // back on the very next render.
  //
  // The naive implementation would include only `activeWorktreeId` in the
  // deps, but we also reference `groupCollapse`/`repoCollapse` inside
  // (their references change on every state update), and `pinnedTree` (for the pinned-worktree early-exit).
  // Including all of those in the deps makes the effect re-fire on every
  // collapse-state change and undo the user's collapse. To preserve the
  // "once per activeWorktreeId" semantics while keeping the deps list
  // exhaustive, we gate the body behind a ref that remembers the last
  // revealed id — subsequent runs no-op until activeWorktreeId actually
  // changes.
  //
  // We also clear keyboardNavRef so the focusedIndex effect above can
  // re-run and move the highlight ring to the freshly-revealed worktree.
  // Without that reset, arrow-key navigation followed by a ⌘K switch
  // would leave the highlight stuck on the old position.
  //
  // Pinned worktrees are rendered exclusively in the Pinned section at
  // the top of the tree (and are filtered out of `groups` via
  // `displayRepos`). They have no presence inside their repo's
  // worktree list, so for a pinned active worktree we reveal it by
  // expanding the Pinned section header — not the repo or group
  // that contains its (now hidden) original entry.
  // Two refs so we run the reveal logic again when the *pinned-ness* of
  // the active worktree changes, not only when activeWorktreeId itself
  // changes. Without the pinned-tracking ref, pinning or unpinning the
  // currently-active worktree early-returns here before
  // `pinnedCollapse.expand` (or the regular repo/group expand) gets
  // a chance to run.
  const revealedWorktreeRef = useRef<string | null>(null);
  const revealedAsPinnedRef = useRef<boolean>(false);
  const revealedGroupByRef = useRef(groupBy);
  useEffect(() => {
    if (!activeWorktreeId) {
      revealedWorktreeRef.current = null;
      revealedAsPinnedRef.current = false;
      return;
    }
    const isActivePinned = pinnedTree.ids.has(activeWorktreeId);
    if (
      revealedWorktreeRef.current === activeWorktreeId &&
      revealedAsPinnedRef.current === isActivePinned &&
      revealedGroupByRef.current === groupBy
    ) {
      return;
    }
    revealedGroupByRef.current = groupBy;
    revealedWorktreeRef.current = activeWorktreeId;
    revealedAsPinnedRef.current = isActivePinned;
    if (isActivePinned) {
      // The Pinned section shows it in every view: open the section and the pins above it.
      pinnedCollapse.expand(PINNED_SECTION_ID);
      let id: string | undefined = activeWorktreeId;
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        const parent: string | undefined = findWorktree(repos, id)?.wt.origin?.worktreeId;
        if (parent && pinnedTree.ids.has(parent)) originCollapse.expand(parent);
        id = parent && pinnedTree.ids.has(parent) ? parent : undefined;
      }
      keyboardNavRef.current = false;
      return;
    }
    if (grouped) {
      // Open what hides the active worktree: its group, its origin ancestors, or its host and
      // repo group.
      const found = findWorktree(repos, activeWorktreeId);
      if (found) groupCollapse.expand(found.wt.groupId ?? UNGROUPED_KEY);
      let id: string | undefined = activeWorktreeId;
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        const entry: { wt: RepoInfo["worktrees"][number]; repo: RepoInfo } | undefined =
          findWorktree(repos, id);
        if (!entry) break;
        const parent = entry.wt.origin;
        if (parent && !parent.removed) originCollapse.expand(parent.worktreeId);
        const hostKey = `host:${entry.wt.hostId || "local"}`;
        hostCollapse.expand(hostKey);
        hostCollapse.expand(`${hostKey}/${entry.repo.name}`);
        id = parent && !parent.removed ? parent.worktreeId : undefined;
      }
      keyboardNavRef.current = false;
      return;
    }
    for (const repo of displayRepos) {
      const containsActive = repo.worktrees.some(
        (wt) => toWorktreeId(repo.name, wt.name, wt.hostId) === activeWorktreeId,
      );
      if (!containsActive) continue;
      repoCollapse.expand(repo.name);
      keyboardNavRef.current = false;
      return;
    }
  }, [
    activeWorktreeId,
    grouped,
    groupBy,
    repos,
    originCollapse,
    hostCollapse,
    displayRepos,
    groupCollapse,
    repoCollapse,
    pinnedCollapse,
    pinnedTree,
  ]);

  // Focus the container so keyboard navigation works immediately.
  // Depends on hasRepos because the container div only renders when
  // repos.length > 0 (see the early return below). On first mount with no
  // repos, containerRef.current is null; re-running when hasRepos flips
  // to true ensures we focus the container once it exists in the DOM.
  const hasRepos = repos.length > 0;
  useEffect(() => {
    if (hasRepos) {
      containerRef.current?.focus({ preventScroll: true });
    }
  }, [hasRepos]);

  const capabilities = useCapabilities();

  // ──────────────────────────────────────────────────────────────────────────
  // KEYBOARD NAVIGATION — READ BEFORE MODIFYING
  //
  // This handler is the backbone of keyboard worktree switching. It has
  // regressed multiple times because the interaction between this container-
  // level handler and the card-level onKeyDown (in WorktreeCard) is subtle:
  //
  //  • Arrow keys update `focusedIndex` which controls the visual highlight
  //    ring on WorktreeCards. However, arrow events may originate on a *child*
  //    card that has DOM focus (e.g. after the user clicked a card or tabbed
  //    into the list). They bubble up here because cards don't handle arrows.
  //
  //  • Enter on a *card* is handled by the card's own onKeyDown, which calls
  //    stopPropagation — so this container handler would NEVER see it.
  //    The card opens *itself*, not necessarily the keyboard-highlighted card.
  //
  //  • To fix this, arrow handlers explicitly re-focus the container via
  //    containerRef.current?.focus(). This guarantees the next Enter fires
  //    HERE, where we use the correct focusedIndex to open the right worktree.
  //
  // DO NOT remove the containerRef.current?.focus() calls. Without them,
  // pressing Enter after arrow-key navigation opens the wrong worktree (or
  // no worktree at all, depending on the platform).
  // ──────────────────────────────────────────────────────────────────────────
  const selectWorktree = useCallback(
    (wsId: string) => {
      // Mark as in-list activation so WorktreeCard's scrollIntoView effect
      // bails out — keyboard focus is already on the chosen card.
      markRecentActivation(wsId);
      const href = capabilities.getWorktreeHref?.(wsId);
      if (href && capabilities.navigate) {
        capabilities.navigate(href);
      } else {
        openWorktree(wsId);
      }
    },
    [capabilities, openWorktree],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (allWorktreeIds.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      keyboardNavRef.current = true;
      setFocusedIndex((prev) => (prev < allWorktreeIds.length - 1 ? prev + 1 : prev));
      // Keep DOM focus on the container so Enter fires here, not on a child card.
      // See block comment above — removing this breaks keyboard Enter navigation.
      containerRef.current?.focus({ preventScroll: true });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      keyboardNavRef.current = true;
      setFocusedIndex((prev) => (prev > 0 ? prev - 1 : prev));
      // Keep DOM focus on the container — same reasoning as ArrowDown above.
      containerRef.current?.focus({ preventScroll: true });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const wsId = allWorktreeIds[focusedIndex];
      if (wsId !== undefined && !isWorktreeDeleting(rawStore.getState(), wsId)) {
        keyboardNavRef.current = false;
        selectWorktree(wsId);
      }
    }
  }

  const allRepoNames = useMemo(() => displayRepos.map((p) => p.name), [displayRepos]);

  // Rows are only candidates for the kind of drag that makes sense: pins among pins, worktrees
  // within their repo in the Repo view, onto rows and pins in the Origin view, onto rows and host
  // headers in the Host view. Repo drags keep their own droppables.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const activeData = args.active.data.current as
        | { kind?: string; repoName?: string }
        | undefined;
      const kindOf = (c: { data: { current?: unknown } }) =>
        (c.data.current as { kind?: string } | undefined)?.kind;
      if (!activeData?.kind) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) => !kindOf(c)),
        });
      }
      const droppableContainers = args.droppableContainers.filter((c) => {
        const kind = kindOf(c);
        if (activeData.kind === "pin") return kind === "pin";
        if (groupBy === "repo") {
          return (
            kind === "wt" &&
            (c.data.current as { repoName?: string } | undefined)?.repoName === activeData.repoName
          );
        }
        if (groupBy === "groups") return kind === "group";
        if (groupBy === "origin") return kind === "wt" || kind === "pin";
        return kind === "wt" || kind === "host";
      });
      const hits = pointerWithin({ ...args, droppableContainers });
      return hits.length > 0 ? hits : closestCenter({ ...args, droppableContainers });
    },
    [groupBy],
  );

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { kind?: string; worktreeId?: string } | undefined;
    if (data?.kind) {
      const entry = [...groupedEntries, ...entriesOf(sortedRepos)].find(
        (e) => e.worktreeId === data.worktreeId,
      );
      setActiveWorktreeDrag(entry ?? null);
      return;
    }
    setActiveDragId(event.active.id as string);
  }

  /** Where the pointer is inside the row it is over, from the drag's start point and delta. */
  function zoneOf(event: DragMoveEvent | DragEndEvent): DropZone | null {
    const { active, over, activatorEvent, delta } = event;
    if (!over) return null;
    const overKind = (over.data.current as { kind?: string } | undefined)?.kind;
    const activeKind = (active.data.current as { kind?: string } | undefined)?.kind;
    if (overKind === "host" || overKind === "group") return "into";
    if (overKind === "pin" && activeKind === "wt") return "into";
    const start = activatorEvent as Partial<MouseEvent & TouchEvent>;
    const startY =
      start.clientY ?? start.touches?.[0]?.clientY ?? start.changedTouches?.[0]?.clientY;
    if (startY === undefined) return null;
    const allowInto = groupBy === "origin" && activeKind === "wt" && overKind === "wt";
    return zoneAt(over.rect, startY + delta.y, allowInto);
  }

  function handleDragMove(event: DragMoveEvent) {
    const overId = event.over ? String(event.over.id) : null;
    const zone = zoneOf(event);
    setDropIndicator((prev) =>
      prev.overId === overId && prev.zone === zone ? prev : { overId, zone },
    );
  }

  function applyPlan(plan: DropPlan, entry: WorktreeEntry | null) {
    if (plan.type === "reorder") {
      reorderWorktreesMutation.mutate({
        order: plan.order,
        scope: plan.scope,
        reparent: plan.reparent,
      });
    } else if (plan.type === "refuse") {
      setDropNotice(plan.reason);
    } else if (plan.type === "move" && entry) {
      const reason = moveRefusal(entry, plan.toHostId, {
        hosts: hostsQuery.data ?? [],
        isAdmin,
      });
      if (reason) setDropNotice(reason);
      else setMoveDialog({ entry, toHostId: plan.toHostId });
    }
  }

  /** Moves a worktree to a group (null for Ungrouped), asking first about its children. */
  function moveToGroup(worktreeId: string, groupId: string | null) {
    const all = entriesOf(sortedRepos);
    const entry = all.find((e) => e.worktreeId === worktreeId);
    if (!entry || (entry.worktree.groupId ?? null) === groupId) return;
    const children = originDescendants(all, worktreeId).filter(
      (e) => (e.worktree.groupId ?? null) !== groupId,
    );
    const group = groups.find((g) => g.id === groupId) ?? null;
    if (children.length > 0) setChildrenPrompt({ entry, group, childCount: children.length });
    else groupMutations.setWorktreeGroup.mutate({ worktreeId, groupId });
  }

  function handleWorktreeDrop(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current as {
      kind: string;
      worktreeId: string;
      repoName: string;
    };
    const overData = over.data.current as {
      kind: string;
      worktreeId?: string;
      repoName?: string;
      hostId?: string;
      groupId?: string | null;
    };
    const zone = zoneOf(event);
    if (!zone) return;
    const activeId = activeData.worktreeId;
    if (activeData.kind === "pin") {
      if (overData.worktreeId)
        applyPlan(planPinDrop(pinnedTree, activeId, overData.worktreeId, zone), null);
      return;
    }
    if (overData.kind === "group") {
      moveToGroup(activeId, overData.groupId ?? null);
      return;
    }
    if (groupBy === "repo") {
      const siblings = entriesOf(displayRepos.filter((r) => r.name === activeData.repoName));
      if (overData.worktreeId) {
        applyPlan(planRepoViewDrop(siblings, activeId, overData.worktreeId, zone), null);
      }
      return;
    }
    if (groupBy === "host") {
      const plan = planHostViewDrop(
        groupedEntries,
        activeId,
        { worktreeId: overData.worktreeId, hostId: overData.hostId ?? "local" },
        zone,
      );
      applyPlan(plan, groupedEntries.find((e) => e.worktreeId === activeId) ?? null);
      return;
    }
    if (overData.worktreeId) {
      applyPlan(planOriginDrop(originTree, pinnedTree, activeId, overData.worktreeId, zone), null);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    setActiveWorktreeDrag(null);
    setDropIndicator({ overId: null, zone: null });
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if ((active.data.current as { kind?: string } | undefined)?.kind) {
      handleWorktreeDrop(event);
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    const allNames = repos.map((p) => p.name);
    const oldIndex = allNames.indexOf(activeId);
    const newIndex = allNames.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;
    reorderReposMutation.mutate(arrayMove(allNames, oldIndex, newIndex));
  }

  function handleDragCancel() {
    setActiveDragId(null);
    setActiveWorktreeDrag(null);
    setDropIndicator({ overId: null, zone: null });
  }

  // A refused drop explains itself for a few seconds.
  useEffect(() => {
    if (!dropNotice) return;
    const timer = setTimeout(() => setDropNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [dropNotice]);

  if (repos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-lg mb-2">No repos registered</p>
        <p className="text-sm">Click the + button to register a folder</p>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        tabIndex={-1}
        data-testid="repo-list__root"
        onKeyDown={handleKeyDown}
        onPointerDown={() => {
          keyboardNavRef.current = false;
        }}
        className="flex flex-col gap-0.5 outline-none min-w-0"
      >
        {dropNotice && (
          <div
            role="status"
            data-testid="repo-list__drop-refused"
            className="mx-2 mb-1 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-bg px-2 py-1.5 text-[12px] text-foreground"
          >
            <span className="flex-1">{dropNotice}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setDropNotice(null)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </div>
        )}
        <DropIndicatorContext.Provider value={dropIndicator}>
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            {/* The Pinned section is the same in every view: each pin with the worktrees
                started from it. Pins reorder among themselves, and pinning or unpinning
                is not something a drag does. */}
            {showPinnedSection && (
              <div key="__pinned" data-testid="repo-list__pinned">
                <button
                  type="button"
                  data-testid="repo-list__pinned-header"
                  onClick={() => pinnedCollapse.toggle(PINNED_SECTION_ID)}
                  aria-expanded={!pinnedSectionCollapsed}
                  className="flex h-9 w-full items-center gap-2 pl-3 pr-4 mb-0.5 text-left transition-colors hover:bg-primary/10"
                >
                  <Pin className="size-3.5 -rotate-45 text-muted-foreground" />
                  <span className="text-[13px] font-semibold text-foreground/90">Pinned</span>
                  <ChevronRight
                    className={`ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform ${
                      pinnedSectionCollapsed ? "" : "rotate-90"
                    }`}
                  />
                </button>
                {/* Collapsed rows are not mounted: a hidden row would still be a drop target. */}
                <CollapsibleSection
                  collapsed={pinnedSectionCollapsed}
                  className="flex flex-col gap-0.5 px-2"
                >
                  {!pinnedSectionCollapsed &&
                    pinnedRows.map((row, i) => (
                      <WorktreeRowView
                        key={row.key}
                        row={row}
                        index={i}
                        mode={groupBy}
                        draggable={groupBy === "origin" || groupBy === "groups" || row.depth === 0}
                        originCollapse={originCollapse}
                        hosts={hostsQuery.data ?? []}
                        statuses={statuses}
                        branchStatuses={branchStatuses}
                        setupStatuses={setupStatuses}
                        focusedIndex={focusedIndex}
                        onShowDeleteDialog={setDeleteDialog}
                        onTogglePinned={togglePinned}
                      />
                    ))}
                </CollapsibleSection>
              </div>
            )}

            {grouped ? (
              <GroupedWorktrees
                mode={groupBy as "groups" | "origin" | "host"}
                rows={groupedRows}
                groupCollapse={groupCollapse}
                groupActions={{
                  onRename: setRenamingGroup,
                  onColor: (group, color) => groupMutations.update.mutate({ id: group.id, color }),
                  onDelete: setDeletingGroup,
                  onAddWorktree: (groupId) => setPickingRepoFor({ groupId }),
                }}
                navStart={pinnedNavCount}
                originCollapse={originCollapse}
                hostCollapse={hostCollapse}
                hosts={hostsQuery.data ?? []}
                statuses={statuses}
                branchStatuses={branchStatuses}
                setupStatuses={setupStatuses}
                focusedIndex={focusedIndex}
                onShowDeleteDialog={setDeleteDialog}
                onTogglePinned={togglePinned}
              />
            ) : (
              <SortableContext items={allRepoNames} strategy={verticalListSortingStrategy}>
                {displayRepos.map((repo) => (
                  // Consecutive repos are separated by spacing alone (no divider line).
                  <div key={repo.name} className="pt-1 first:pt-0">
                    <SortableRepo
                      repo={repo}
                      statuses={statuses}
                      branchStatuses={branchStatuses}
                      setupStatuses={setupStatuses}
                      removeRepo={(name) => removeRepoMutation.mutate(name)}
                      onPromoteToGit={setPromoteDialog}
                      setWorktreeDialog={setWorktreeDialog}
                      onShowDeleteDialog={setDeleteDialog}
                      focusedIndex={focusedIndex}
                      worktreeIndexStart={worktreeIndexMap.get(repo.name) ?? 0}
                      collapsed={repoCollapse.isCollapsed(repo.name)}
                      onToggleCollapse={repoCollapse.toggle}
                      hasPinnedSiblings={reposWithPinned.has(repo.name)}
                      onTogglePinned={togglePinned}
                      hosts={hostsQuery.data ?? []}
                    />
                  </div>
                ))}
              </SortableContext>
            )}
            {/* dropAnimation={null} disables dnd-kit's default snap-back. The reorder
            mutations run an optimistic update in onMutate, so when the user releases we want
            the overlay to disappear instantly and the list to look like the new order. */}
            <DragOverlay dropAnimation={null}>
              {activeWorktreeDrag ? (
                <div className="rounded border bg-background px-2 py-1 text-[13px] font-medium shadow-lg">
                  {activeWorktreeDrag.worktree.name}
                </div>
              ) : activeDragId ? (
                <div className="flex items-center gap-2 px-1 py-1 bg-background rounded shadow-lg border">
                  <RepoAvatar
                    avatar={repos.find((p) => p.name === activeDragId)?.avatar}
                    className="size-3.5"
                    fallback={<Folder className="size-3.5 shrink-0 text-muted-foreground" />}
                  />
                  <span className="text-[13px] font-semibold text-foreground">{activeDragId}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </DropIndicatorContext.Provider>
      </div>

      <GroupNameDialog
        open={renamingGroup !== null}
        onOpenChange={(open) => {
          if (!open) setRenamingGroup(null);
        }}
        title="Rename group"
        submitLabel="Rename"
        initialName={renamingGroup?.name ?? ""}
        onSubmit={(name) => {
          if (renamingGroup) groupMutations.update.mutate({ id: renamingGroup.id, name });
        }}
      />

      <DeleteGroupDialog
        open={deletingGroup !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingGroup(null);
        }}
        groupName={deletingGroup?.name ?? ""}
        onConfirm={() => {
          if (deletingGroup) groupMutations.remove.mutate({ id: deletingGroup.id });
        }}
      />

      <MoveChildrenDialog
        open={childrenPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setChildrenPrompt(null);
        }}
        worktreeName={childrenPrompt?.entry.worktree.name ?? ""}
        groupName={childrenPrompt?.group?.name ?? "Ungrouped"}
        childCount={childrenPrompt?.childCount ?? 0}
        onChoose={(withChildren) => {
          if (!childrenPrompt) return;
          groupMutations.setWorktreeGroup.mutate({
            worktreeId: childrenPrompt.entry.worktreeId,
            groupId: childrenPrompt.group?.id ?? null,
            withChildren,
          });
        }}
      />

      {moveDialog && (
        <MoveWorktreeDialog
          open
          onOpenChange={(open) => {
            if (!open) setMoveDialog(null);
          }}
          repoName={moveDialog.entry.repo.name}
          worktree={moveDialog.entry.worktree}
          initialTarget={moveDialog.toHostId}
        />
      )}

      <PickRepoDialog
        open={pickingRepoFor !== null}
        onOpenChange={(open) => {
          if (!open) setPickingRepoFor(null);
        }}
        groupName={groups.find((g) => g.id === pickingRepoFor?.groupId)?.name ?? "Ungrouped"}
        repos={repos.filter((r) => r.kind !== "plain").map((r) => r.name)}
        onPick={(repo) => {
          setWorktreeDialogGroup(pickingRepoFor?.groupId ?? null);
          setWorktreeDialogRepo(repo);
        }}
      />

      <NewWorktreeDialog
        repoName={worktreeDialog ?? ""}
        groupId={worktreeDialogGroup}
        open={worktreeDialog !== null}
        onOpenChange={(open) => setWorktreeDialog(open ? worktreeDialog : null)}
      />

      <DeleteWorktreeDialog
        open={deleteDialog !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDialog(null);
        }}
        onConfirm={() => {
          if (deleteDialog) {
            removeWorktreeMutation.mutate({
              repo: deleteDialog.repoName,
              name: deleteDialog.name,
              hostId: deleteDialog.hostId,
            });
            setDeleteDialog(null);
          }
        }}
        branchName={deleteDialog?.name ?? ""}
        isUnmerged={deleteDialog?.isUnmerged ?? false}
        isDirty={deleteDialog?.isDirty ?? false}
        hasUnpushedCommits={deleteDialog?.hasUnpushedCommits ?? false}
      />

      <PromoteToGitDialog
        open={promoteDialog !== null}
        onOpenChange={(open) => {
          if (!open) setPromoteDialog(null);
        }}
        onConfirm={() => {
          if (!promoteDialog) return;
          // Wait for the mutation to settle before dismissing the
          // dialog. If the server errors (path deleted, already a git
          // repo, etc.) we want the dialog to stay open so the
          // user can see the error toast in context; closing
          // synchronously hides the trigger before the failure is
          // visible.
          promoteRepoToGitMutation.mutate(promoteDialog, {
            onSettled: () => setPromoteDialog(null),
          });
        }}
        repoName={promoteDialog ?? ""}
      />
    </>
  );
}
