import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDndContext,
  useDroppable,
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
import {
  Check,
  ChevronRight,
  Circle,
  Clipboard,
  Folder,
  FolderOpen,
  GitBranch,
  ListMinus,
  MoreVertical,
  Pin,
  Plus,
  Tag,
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
import { useAdapter, useCapabilities } from "../context";
import {
  LABELS_COLLAPSE_KEY,
  PINNED_COLLAPSE_KEY,
  PINNED_SECTION_ID,
  REPOS_COLLAPSE_KEY,
  UNLABELED_KEY,
  useCollapseState,
} from "../hooks/use-collapse-state";
import { useHostRequests } from "../hooks/use-host-requests";
import { usePinnedWorktrees } from "../hooks/use-pinned-worktrees";
import {
  usePromoteRepoToGit,
  useRemoveRepo,
  useRemoveWorktree,
  useReorderRepos,
  useUpdateRepoLabel,
} from "../hooks/use-repo-mutations";
import { useRepos } from "../hooks/use-repos";
import { useSettingsQuery } from "../hooks/use-settings-query";
import { isWorktreeDeleting } from "../stores/dashboard-store";
import { useDashboardStore, useRawDashboardStore } from "../stores/index";
import type {
  DeleteDialogInfo,
  LabelDefinition,
  RepoInfo,
  SetupStatus,
  WorktreeBranchStatus,
  WorktreeStatus,
} from "../types";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { NewWorktreeDialog } from "./NewWorktreeForm";
import { PromoteToGitDialog } from "./PromoteToGitDialog";
import { ProvisioningWorktreeCard } from "./ProvisioningWorktreeCard";
import { RepoAvatar } from "./RepoAvatar";
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
  updateRepoLabel: (name: string, label: string | null) => void;
  /** Opens the promote-to-git confirmation dialog for the given repo. */
  onPromoteToGit: (name: string) => void;
  labels: LabelDefinition[];
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
}

function SortableRepo({
  repo,
  statuses,
  branchStatuses,
  setupStatuses,
  removeRepo,
  updateRepoLabel,
  onPromoteToGit,
  labels,
  setWorktreeDialog,
  onShowDeleteDialog,
  focusedIndex,
  worktreeIndexStart,
  collapsed,
  onToggleCollapse,
  hasPinnedSiblings,
  onTogglePinned,
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
  const plainWorktreeId = isPlain ? toWorktreeId(repo.name, plainName) : "";
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
      repo.worktrees.some((wt) => toWorktreeId(repo.name, wt.name) === activeWorktreeId),
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
  // share the same Item/Sub/SubTrigger/SubContent/Portal shape. Keeps the two
  // menus from drifting.
  const renderMenuItems = (menu: {
    Item: ElementType;
    Sub: ElementType;
    SubTrigger: ElementType;
    SubContent: ElementType;
    Portal: ElementType;
  }) => {
    const { Item, Sub, SubTrigger, SubContent, Portal } = menu;
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
        {labels.length > 0 && (
          <Sub>
            <SubTrigger data-testid="repo-list__action--set-label">
              <Tag />
              Set label
            </SubTrigger>
            <Portal>
              <SubContent data-testid="repo-list__label-submenu">
                <Item onClick={() => updateRepoLabel(repo.name, null)}>
                  <span className="flex-1">None</span>
                  {!repo.label && <Check className="size-3" />}
                </Item>
                {labels.map((lbl) => (
                  <Item key={lbl.id} onClick={() => updateRepoLabel(repo.name, lbl.id)}>
                    <span
                      className="size-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: lbl.color }}
                    />
                    <span className="flex-1">{lbl.name}</span>
                    {repo.label === lbl.id && <Check className="size-3" />}
                  </Item>
                ))}
              </SubContent>
            </Portal>
          </Sub>
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
                // through AgentStatusIndicator's fallback so the idle
                // icon can match a git repo's folder size — using the
                // indicator's size-3 fallback would make plain headers
                // read as nested worktree cards (see #427 review).
                plainAgent &&
                (plainAgent.status === "working" || plainAgent.status === "needs_attention") ? (
                  <AgentStatusIndicator agent={plainAgent} isActive={plainIsActive} />
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
                      Sub: DropdownMenuSub,
                      SubTrigger: DropdownMenuSubTrigger,
                      SubContent: DropdownMenuSubContent,
                      Portal: DropdownMenuPortal,
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
            Sub: ContextMenuSub,
            SubTrigger: ContextMenuSubTrigger,
            SubContent: ContextMenuSubContent,
            Portal: ContextMenuPortal,
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
          {repo.worktrees.length === 0 ? (
            hasPinnedSiblings || provisioning.length > 0 ? null : (
              <p className="text-[13px] text-foreground/60 px-4 py-2">No worktrees yet</p>
            )
          ) : (
            repo.worktrees.map((wt) => {
              const wsId = toWorktreeId(repo.name, wt.name);
              const currentIndex = worktreeIndex++;
              return (
                <WorktreeCard
                  key={wt.name}
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
                />
              );
            })
          )}
        </CollapsibleSection>
      )}
    </div>
  );
}

interface DroppableLabelHeaderProps {
  labelId: string;
  label: LabelDefinition;
  collapsed: boolean;
  onToggle: () => void;
}

function DroppableLabelHeader({ labelId, label, collapsed, onToggle }: DroppableLabelHeaderProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${labelId}` });
  return (
    <button
      type="button"
      ref={setNodeRef}
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={`flex h-9 w-full items-center gap-2 pl-3 pr-4 mb-0.5 text-left transition-colors hover:bg-primary/10 ${
        isOver ? "bg-primary/20" : ""
      }`}
    >
      <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
      <span className="text-[13px] font-semibold text-foreground/90">{label.name}</span>
      <ChevronRight
        className={`ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform ${
          collapsed ? "" : "rotate-90"
        }`}
      />
    </button>
  );
}

interface DroppableUnlabeledHeaderProps {
  collapsed: boolean;
  onToggle: () => void;
}

function DroppableUnlabeledHeader({ collapsed, onToggle }: DroppableUnlabeledHeaderProps) {
  const { setNodeRef, isOver } = useDroppable({ id: "group:__unlabeled" });
  return (
    <button
      type="button"
      ref={setNodeRef}
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={`flex h-9 w-full items-center gap-2 pl-3 pr-4 mb-0.5 text-left transition-colors hover:bg-primary/10 ${
        isOver ? "bg-primary/20" : ""
      }`}
    >
      {/* Hollow circle mirrors the position of the filled color dot on labelled
          group headers, signalling "no label" without borrowing a real color. */}
      <Circle className="size-2.5 shrink-0 text-muted-foreground" />
      <span className="text-[13px] font-semibold text-foreground/90">Unlabeled</span>
      <ChevronRight
        className={`ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform ${
          collapsed ? "" : "rotate-90"
        }`}
      />
    </button>
  );
}

interface RepoListProps {
  labelFilter: string | null;
}

export function RepoList({ labelFilter }: RepoListProps) {
  const { repos } = useRepos();
  const { settings } = useSettingsQuery();
  const labels = settings.labels ?? [];
  const statuses = useDashboardStore((s) => s.statuses);
  const branchStatuses = useDashboardStore((s) => s.branchStatuses);
  const setupStatuses = useDashboardStore((s) => s.setupStatuses);
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const activeWorktreeId = useDashboardStore((s) => s.activeWorktreeId);

  const removeRepoMutation = useRemoveRepo();
  const reorderReposMutation = useReorderRepos();
  const updateRepoLabelMutation = useUpdateRepoLabel();
  const promoteRepoToGitMutation = usePromoteRepoToGit();
  const removeWorktreeMutation = useRemoveWorktree();

  const [worktreeDialog, setWorktreeDialog] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogInfo | null>(null);
  /** Repo name whose "Promote to git" confirmation dialog is open. */
  const [promoteDialog, setPromoteDialog] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const rawStore = useRawDashboardStore();
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const keyboardNavRef = useRef(false);

  const repoCollapse = useCollapseState(REPOS_COLLAPSE_KEY);
  const labelCollapse = useCollapseState(LABELS_COLLAPSE_KEY);
  const pinnedCollapse = useCollapseState(PINNED_COLLAPSE_KEY);
  const { pinned: pinnedEntriesRaw, toggle: togglePinned } = usePinnedWorktrees();
  // Plain (non-git) repos have no separate worktree card to pull up
  // to a Pinned section — they're already flat at the repo level. Drop
  // them from the pinned list so a stale `pinned=true` row doesn't show
  // a confusing duplicate entry at the top of the tree.
  const pinnedEntries = useMemo(
    () => pinnedEntriesRaw.filter((e) => e.repo.kind !== "plain"),
    [pinnedEntriesRaw],
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

  // Each pinned worktree is rendered exclusively in the Pinned section, so
  // we strip pinned worktrees out of the regular tree. Track which repos
  // had any pinned worktrees so SortableRepo can hide the misleading
  // "No worktrees yet" copy when the only reason a repo looks empty is
  // that everything got pinned.
  //
  // Plain (non-git) repos are flat — the repo header IS the implicit
  // worktree, with no nested card to pull up to a separate "Pinned"
  // section. Skip the filter for them so a stray `pinned=true` row (e.g.
  // pinned before the feature was disabled for plain repos) doesn't
  // strand SortableRepo with an empty `worktrees: []` and crash on
  // `worktrees[0].branch`.
  const { displayRepos, reposWithPinned } = useMemo(() => {
    const withPinned = new Set<string>();
    const display = repos.map((p) => {
      if (p.kind === "plain") return p;
      const filtered = p.worktrees.filter((w) => !w.pinned);
      if (filtered.length !== p.worktrees.length) withPinned.add(p.name);
      return { ...p, worktrees: filtered };
    });
    return { displayRepos: display, reposWithPinned: withPinned };
  }, [repos]);

  const pinnedSectionCollapsed = pinnedCollapse.isCollapsed(PINNED_SECTION_ID);
  const showPinnedSection = pinnedEntries.length > 0;
  const pinnedNavCount = showPinnedSection && !pinnedSectionCollapsed ? pinnedEntries.length : 0;

  const groups = useMemo(() => {
    if (labels.length === 0)
      return [
        {
          labelId: null as string | null,
          label: null as LabelDefinition | null,
          repos: displayRepos,
        },
      ];

    const byLabel = new Map<string | null, RepoInfo[]>();
    for (const p of displayRepos) {
      const key = p.label ?? null;
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key)!.push(p);
    }

    const result: {
      labelId: string | null;
      label: LabelDefinition | null;
      repos: RepoInfo[];
    }[] = [];
    for (const lbl of labels) {
      const grouped = byLabel.get(lbl.id);
      if (grouped) {
        result.push({ labelId: lbl.id, label: lbl, repos: grouped });
      }
    }
    const unlabeled = byLabel.get(null);
    if (unlabeled) {
      result.push({ labelId: null, label: null, repos: unlabeled });
    }
    return result;
  }, [displayRepos, labels]);

  const visibleGroups = useMemo(() => {
    if (!labelFilter) return groups;
    return groups.filter((g) => g.labelId === labelFilter);
  }, [groups, labelFilter]);

  // Only count worktrees that are actually rendered — collapsed
  // repos/labels hide their worktrees entirely, and keyboard arrow
  // navigation must skip over them so focus never lands on something the
  // user can't see. Pinned worktrees are always at the top of the list
  // (independent of label filter), then the regular tree follows.
  const allWorktreeIds = useMemo(() => {
    const headerVisible = labels.length > 0 && !labelFilter;
    const pinnedPart = pinnedNavCount > 0 ? pinnedEntries.map((e) => e.worktreeId) : [];
    const rest = visibleGroups.flatMap((g) => {
      const groupKey = g.labelId ?? UNLABELED_KEY;
      if (headerVisible && labelCollapse.isCollapsed(groupKey)) return [];
      return g.repos.flatMap((p) => {
        if (repoCollapse.isCollapsed(p.name)) return [];
        return p.worktrees.map((wt) => toWorktreeId(p.name, wt.name));
      });
    });
    return [...pinnedPart, ...rest];
  }, [
    visibleGroups,
    labels.length,
    labelFilter,
    labelCollapse,
    repoCollapse,
    pinnedEntries,
    pinnedNavCount,
  ]);

  const worktreeIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    // Reserve slots [0..pinnedNavCount) for pinned worktrees so per-repo
    // worktreeIndexStart values align with allWorktreeIds.
    let index = pinnedNavCount;
    const headerVisible = labels.length > 0 && !labelFilter;
    for (const group of visibleGroups) {
      const groupKey = group.labelId ?? UNLABELED_KEY;
      if (headerVisible && labelCollapse.isCollapsed(groupKey)) continue;
      for (const repo of group.repos) {
        map.set(repo.name, index);
        if (!repoCollapse.isCollapsed(repo.name)) {
          index += repo.worktrees.length;
        }
      }
    }
    return map;
  }, [visibleGroups, labels.length, labelFilter, labelCollapse, repoCollapse, pinnedNavCount]);

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
  // and label group it belongs to. This should run ONLY when
  // activeWorktreeId changes — i.e. when the user switches worktrees via
  // the ⌘K picker, URL nav, notifications, etc. After the initial
  // reveal we deliberately leave the collapse state alone so the user can
  // collapse the ancestors of the active worktree (via the "Collapse all"
  // toolbar button or by clicking a header) without this effect fighting
  // back on the very next render.
  //
  // The naive implementation would include only `activeWorktreeId` in the
  // deps, but we also reference `labelCollapse`/`repoCollapse` inside
  // (their references change on every state update), `groups` (which we
  // walk), and `pinnedEntries` (for the pinned-worktree early-exit).
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
  // expanding the Pinned section header — not the repo or label group
  // that contains its (now hidden) original entry.
  // Two refs so we run the reveal logic again when the *pinned-ness* of
  // the active worktree changes, not only when activeWorktreeId itself
  // changes. Without the pinned-tracking ref, pinning or unpinning the
  // currently-active worktree early-returns here before
  // `pinnedCollapse.expand` (or the regular repo/label expand) gets
  // a chance to run.
  const revealedWorktreeRef = useRef<string | null>(null);
  const revealedAsPinnedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!activeWorktreeId) {
      revealedWorktreeRef.current = null;
      revealedAsPinnedRef.current = false;
      return;
    }
    const isActivePinned = pinnedEntries.some((e) => e.worktreeId === activeWorktreeId);
    if (
      revealedWorktreeRef.current === activeWorktreeId &&
      revealedAsPinnedRef.current === isActivePinned
    ) {
      return;
    }
    revealedWorktreeRef.current = activeWorktreeId;
    revealedAsPinnedRef.current = isActivePinned;
    if (isActivePinned) {
      pinnedCollapse.expand(PINNED_SECTION_ID);
      keyboardNavRef.current = false;
      return;
    }
    for (const group of groups) {
      for (const repo of group.repos) {
        const containsActive = repo.worktrees.some(
          (wt) => toWorktreeId(repo.name, wt.name) === activeWorktreeId,
        );
        if (!containsActive) continue;
        if (labelFilter && group.labelId !== labelFilter) return;
        const headerVisible = labels.length > 0 && !labelFilter;
        if (headerVisible) {
          labelCollapse.expand(group.labelId ?? UNLABELED_KEY);
        }
        repoCollapse.expand(repo.name);
        keyboardNavRef.current = false;
        return;
      }
    }
  }, [
    activeWorktreeId,
    groups,
    labelFilter,
    labels.length,
    labelCollapse,
    repoCollapse,
    pinnedCollapse,
    pinnedEntries,
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

  const allRepoNames = useMemo(
    () => visibleGroups.flatMap((g) => g.repos.map((p) => p.name)),
    [visibleGroups],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (overId.startsWith("group:")) {
      const targetLabelId = overId === "group:__unlabeled" ? null : overId.slice("group:".length);
      updateRepoLabelMutation.mutate({ name: activeId, label: targetLabelId });
      return;
    }

    const activeGroup = groups.find((g) => g.repos.some((p) => p.name === activeId));
    const overGroup = groups.find((g) => g.repos.some((p) => p.name === overId));

    if (!activeGroup || !overGroup) return;

    if (activeGroup.labelId === overGroup.labelId) {
      const allNames = repos.map((p) => p.name);
      const oldIndex = allNames.indexOf(activeId);
      const newIndex = allNames.indexOf(overId);
      reorderReposMutation.mutate(arrayMove(allNames, oldIndex, newIndex));
    } else {
      updateRepoLabelMutation.mutate({ name: activeId, label: overGroup.labelId });
    }
  }

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
        {/* Pinned section — rendered outside DndContext/SortableContext so
            pinned worktrees cannot be touched by repo drag-and-drop. It
            also ignores the label filter (pinned ws should always be
            visible) and is the *only* place pinned worktrees render. */}
        {showPinnedSection && (
          <div key="__pinned">
            <button
              type="button"
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
            <CollapsibleSection
              collapsed={pinnedSectionCollapsed}
              className="flex flex-col gap-0.5 px-2"
            >
              {pinnedEntries.map(({ repo, worktree, worktreeId }, i) => (
                <WorktreeCard
                  key={worktreeId}
                  worktree={worktree}
                  repoName={repo.name}
                  defaultBranch={repo.defaultBranch}
                  repoKind={repo.kind}
                  status={statuses.get(worktreeId)}
                  branchStatus={branchStatuses.get(worktreeId)}
                  setupStatus={setupStatuses.get(worktreeId)}
                  isFocused={!pinnedSectionCollapsed && i === focusedIndex}
                  onShowDeleteDialog={setDeleteDialog}
                  showRepoName
                  onTogglePinned={togglePinned}
                />
              ))}
            </CollapsibleSection>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={allRepoNames} strategy={verticalListSortingStrategy}>
            {visibleGroups.map((group) => {
              const groupKey = group.labelId ?? UNLABELED_KEY;
              // When a label filter is active we render a single group without
              // a header, so honour the group's collapsed state only when the
              // header is visible (otherwise users would have no way to expand
              // it again). Same for the no-labels mode.
              const headerVisible = labels.length > 0 && !labelFilter;
              const groupCollapsed = headerVisible && labelCollapse.isCollapsed(groupKey);
              return (
                <div key={groupKey}>
                  {headerVisible &&
                    (group.label ? (
                      <DroppableLabelHeader
                        labelId={group.labelId!}
                        label={group.label}
                        collapsed={groupCollapsed}
                        onToggle={() => labelCollapse.toggle(groupKey)}
                      />
                    ) : (
                      <DroppableUnlabeledHeader
                        collapsed={groupCollapsed}
                        onToggle={() => labelCollapse.toggle(groupKey)}
                      />
                    ))}
                  <CollapsibleSection collapsed={groupCollapsed}>
                    {group.repos.map((repo) => (
                      // Consecutive repos in a label group are separated by
                      // spacing alone (no divider line); the first row sits
                      // flush under the label header.
                      <div key={repo.name} className="pt-1 first:pt-0">
                        <SortableRepo
                          repo={repo}
                          statuses={statuses}
                          branchStatuses={branchStatuses}
                          setupStatuses={setupStatuses}
                          removeRepo={(name) => removeRepoMutation.mutate(name)}
                          updateRepoLabel={(name, label) =>
                            updateRepoLabelMutation.mutate({ name, label })
                          }
                          onPromoteToGit={setPromoteDialog}
                          labels={labels}
                          setWorktreeDialog={setWorktreeDialog}
                          onShowDeleteDialog={setDeleteDialog}
                          focusedIndex={focusedIndex}
                          worktreeIndexStart={worktreeIndexMap.get(repo.name) ?? 0}
                          collapsed={repoCollapse.isCollapsed(repo.name)}
                          onToggleCollapse={repoCollapse.toggle}
                          hasPinnedSiblings={reposWithPinned.has(repo.name)}
                          onTogglePinned={togglePinned}
                        />
                      </div>
                    ))}
                  </CollapsibleSection>
                </div>
              );
            })}
          </SortableContext>
          {/* dropAnimation={null} disables dnd-kit's default snap-back. The
              reorder mutation runs an optimistic update in onMutate, so when
              the user releases we want the overlay to disappear instantly
              and the list to look like the new order — not animate back to
              the original drop position before re-rendering. */}
          <DragOverlay dropAnimation={null}>
            {activeDragId ? (
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
      </div>

      <NewWorktreeDialog
        repoName={worktreeDialog ?? ""}
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
