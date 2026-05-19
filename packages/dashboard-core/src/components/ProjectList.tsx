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
  Clipboard,
  Folder,
  FolderOpen,
  GitBranch,
  ListMinus,
  Pin,
  PinOff,
  Plus,
  Tag,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCapabilities } from "../context";
import {
  LABELS_COLLAPSE_KEY,
  PINNED_COLLAPSE_KEY,
  PINNED_SECTION_ID,
  PROJECTS_COLLAPSE_KEY,
  UNLABELED_KEY,
  useCollapseState,
} from "../hooks/use-collapse-state";
import { usePinnedWorkspaces } from "../hooks/use-pinned-workspaces";
import {
  usePromoteProjectToGit,
  useRemoveProject,
  useRemoveWorkspace,
  useReorderProjects,
  useUpdateProjectLabel,
} from "../hooks/use-project-mutations";
import { useProjects } from "../hooks/use-projects";
import { useSettingsQuery } from "../hooks/use-settings-query";
import { toWorkspaceId } from "../lib/workspace-id";
import { useDashboardStore } from "../stores/index";
import type {
  DeleteDialogInfo,
  LabelDefinition,
  ProjectInfo,
  SetupStatus,
  WorkspaceBranchStatus,
  WorkspaceStatus,
} from "../types";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog";
import { NewWorkspaceDialog } from "./NewWorkspaceForm";
import { WorkspaceCard } from "./WorkspaceCard";

interface SortableProjectProps {
  project: ProjectInfo;
  statuses: Map<string, WorkspaceStatus>;
  branchStatuses: Map<string, WorkspaceBranchStatus>;
  setupStatuses: Map<string, SetupStatus>;
  removeProject: (name: string) => void;
  updateProjectLabel: (name: string, label: string | null) => void;
  promoteProjectToGit: (name: string) => void;
  labels: LabelDefinition[];
  setWorkspaceDialog: (name: string | null) => void;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  focusedIndex: number;
  workspaceIndexStart: number;
  collapsed: boolean;
  onToggleCollapse: (name: string) => void;
  /**
   * True when the project had at least one worktree before pinned ones were
   * filtered out. Used to suppress the misleading "No workspaces yet" message
   * when all worktrees are pinned and shown in the Pinned section instead.
   */
  hasPinnedSiblings?: boolean;
  onTogglePinned: (project: string, branch: string, currentlyPinned: boolean) => void;
}

function SortableProject({
  project,
  statuses,
  branchStatuses,
  setupStatuses,
  removeProject,
  updateProjectLabel,
  promoteProjectToGit,
  labels,
  setWorkspaceDialog,
  onShowDeleteDialog,
  focusedIndex,
  workspaceIndexStart,
  collapsed,
  onToggleCollapse,
  hasPinnedSiblings,
  onTogglePinned,
}: SortableProjectProps) {
  const isPlain = project.kind === "plain";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.name,
  });
  const capabilities = useCapabilities();
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

  // Plain projects flatten: the project header IS the implicit workspace's
  // card. There's no nested "main" row, no collapse chevron, no "+" Add
  // workspace button — see #427. The header inherits everything the
  // WorkspaceCard would have done: agent-status dot, click-to-open,
  // focus/active highlighting, pin toggle, etc.
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  const plainWorkspaceId = isPlain ? toWorkspaceId(project.name, project.worktrees[0].branch) : "";
  const plainIsActive = useDashboardStore(
    (s) => isPlain && s.activeWorkspaceId === plainWorkspaceId,
  );
  const plainHref = isPlain ? capabilities.getWorkspaceHref?.(plainWorkspaceId) : undefined;
  const plainAgent = isPlain ? statuses.get(plainWorkspaceId)?.agent : undefined;
  const plainIsPinned = isPlain ? (project.worktrees[0].pinned ?? false) : false;
  const plainIsFocused = isPlain && workspaceIndexStart === focusedIndex;

  // Single onClick / onKeyDown for the plain-project header (mirrors the
  // navigate-or-open dance WorkspaceCard does). For git projects the same
  // div toggles collapse — branched below.
  const handlePlainOpen = () => {
    if (!isPlain) return;
    clearNeedsAttention(plainWorkspaceId);
    if (plainHref && capabilities.navigate) {
      capabilities.navigate(plainHref);
    } else if (!plainHref) {
      openWorkspace(plainWorkspaceId);
    }
  };

  let workspaceIndex = workspaceIndexStart;

  // Header className. Git projects keep the old "row of muted text + +
  // button" treatment. Plain projects style the row like a WorkspaceCard
  // (hover/active background, left border on active, focus ring) so the
  // user can tell at a glance that it's a clickable workspace.
  const headerClassName = isPlain
    ? `group flex items-center justify-between mb-0.5 pl-1 pr-1 py-1 select-none touch-pan-y rounded-sm cursor-pointer transition-colors hover:bg-accent/50 ${
        plainIsActive ? "bg-accent/50 border-l-2 border-l-primary" : ""
      } ${plainIsFocused ? "ring-2 ring-inset ring-ring" : ""}`
    : "group flex items-center justify-between mb-0.5 pl-1 pr-0 select-none touch-pan-y";

  return (
    <div ref={setNodeRef} style={style} className="min-w-0 px-2">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* The header is a click/tap target on both desktop and mobile.
              For git projects it toggles collapse; for plain projects it
              opens the implicit workspace (the project IS the workspace).
              Keyboard nav lives at the workspace-card level for git
              projects; for plain projects the same role moves up here. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the container-level handler on the ProjectList (see "KEYBOARD NAVIGATION — READ BEFORE MODIFYING" below) */}
          <div
            className={headerClassName}
            onClick={() => (isPlain ? handlePlainOpen() : onToggleCollapse(project.name))}
          >
            {/* Drag listeners live on the title (folder icon + project name)
                so the project name itself is the drag handle. The 8px
                MouseSensor / 250ms TouchSensor thresholds mean a still
                click/tap bubbles up to the outer onClick without starting
                a drag. */}
            <div
              className="flex items-center gap-2 min-w-0 cursor-grab"
              {...attributes}
              {...listeners}
            >
              {isPlain ? (
                <AgentStatusIndicator agent={plainAgent} isActive={plainIsActive} />
              ) : collapsed ? (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <h2
                    className={`text-sm truncate ${
                      isPlain
                        ? plainIsActive
                          ? "font-semibold text-foreground"
                          : "font-medium text-muted-foreground"
                        : "font-semibold text-foreground/80"
                    }`}
                  >
                    {project.name}
                  </h2>
                </TooltipTrigger>
                <TooltipContent side="top">{project.name}</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-1">
              {/* Plain (non-git) projects have a single implicit workspace
                  and don't support `git worktree add`, so the "+" Add
                  workspace button is hidden — see #427. The server also
                  rejects `workspaces.create` as a backstop. */}
              {!isPlain && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setWorkspaceDialog(project.name);
                      }}
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add workspace</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Git projects toggle collapse from this menu (keyboard fallback
              for users who can't reach the header click target). Plain
              projects have nothing to collapse — they're already flat. */}
          {!isPlain && (
            <ContextMenuItem onClick={() => onToggleCollapse(project.name)}>
              <ChevronRight className={collapsed ? "" : "rotate-90"} />
              {collapsed ? "Expand" : "Collapse"}
            </ContextMenuItem>
          )}
          {/* Pin/unpin the implicit workspace for plain projects — for git
              projects pinning lives on the per-worktree WorkspaceCard
              context menu instead. */}
          {isPlain && (
            <ContextMenuItem
              onClick={() =>
                onTogglePinned(project.name, project.worktrees[0].branch, plainIsPinned)
              }
            >
              {plainIsPinned ? <PinOff /> : <Pin />}
              {plainIsPinned ? "Unpin workspace" : "Pin workspace"}
            </ContextMenuItem>
          )}
          {labels.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Tag className="size-4 mr-2" />
                Set label
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent>
                  <ContextMenuItem onClick={() => updateProjectLabel(project.name, null)}>
                    <span className="flex-1">None</span>
                    {!project.label && <Check className="size-3 ml-2" />}
                  </ContextMenuItem>
                  {labels.map((lbl) => (
                    <ContextMenuItem
                      key={lbl.id}
                      onClick={() => updateProjectLabel(project.name, lbl.id)}
                    >
                      <span
                        className="size-2.5 rounded-full shrink-0 mr-2"
                        style={{ backgroundColor: lbl.color }}
                      />
                      <span className="flex-1">{lbl.name}</span>
                      {project.label === lbl.id && <Check className="size-3 ml-2" />}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>
          )}
          {isPlain && (
            <ContextMenuItem onClick={() => promoteProjectToGit(project.name)}>
              <GitBranch />
              Promote to git
            </ContextMenuItem>
          )}
          {capabilities.copyPath && (
            <ContextMenuItem onClick={() => navigator.clipboard.writeText(project.path)}>
              <Clipboard />
              Copy path
            </ContextMenuItem>
          )}
          {capabilities.revealInFinder && (
            <ContextMenuItem onClick={() => capabilities.revealInFinder!(project.path)}>
              <FolderOpen />
              Open in Finder
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => removeProject(project.name)}>
            <ListMinus />
            Remove from list
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Nested workspaces section — only meaningful for git projects.
          Plain projects are flat: the header above IS the workspace. */}
      {!isPlain && !collapsed && (
        <div className="flex flex-col gap-0.5 overflow-hidden">
          {project.worktrees.length === 0 ? (
            hasPinnedSiblings ? null : (
              <p className="text-sm text-muted-foreground px-4 py-2">No workspaces yet</p>
            )
          ) : (
            project.worktrees.map((wt) => {
              const wsId = toWorkspaceId(project.name, wt.branch);
              const currentIndex = workspaceIndex++;
              return (
                <WorkspaceCard
                  key={wt.branch}
                  worktree={wt}
                  projectName={project.name}
                  defaultBranch={project.defaultBranch}
                  projectKind={project.kind}
                  status={statuses.get(wsId)}
                  branchStatus={branchStatuses.get(wsId)}
                  setupStatus={setupStatuses.get(wsId)}
                  isFocused={currentIndex === focusedIndex}
                  onShowDeleteDialog={onShowDeleteDialog}
                  onTogglePinned={onTogglePinned}
                />
              );
            })
          )}
        </div>
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
        isOver ? "bg-primary/20" : "bg-accent"
      }`}
    >
      <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
      <span className="text-sm font-semibold text-foreground/80">{label.name}</span>
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
        isOver ? "bg-primary/20" : "bg-accent"
      }`}
    >
      <span className="text-sm font-semibold text-foreground/80">Unlabeled</span>
      <ChevronRight
        className={`ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform ${
          collapsed ? "" : "rotate-90"
        }`}
      />
    </button>
  );
}

interface ProjectListProps {
  labelFilter: string | null;
}

export function ProjectList({ labelFilter }: ProjectListProps) {
  const { projects } = useProjects();
  const { settings } = useSettingsQuery();
  const labels = settings.labels ?? [];
  const statuses = useDashboardStore((s) => s.statuses);
  const branchStatuses = useDashboardStore((s) => s.branchStatuses);
  const setupStatuses = useDashboardStore((s) => s.setupStatuses);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);

  const removeProjectMutation = useRemoveProject();
  const reorderProjectsMutation = useReorderProjects();
  const updateProjectLabelMutation = useUpdateProjectLabel();
  const promoteProjectToGitMutation = usePromoteProjectToGit();
  const removeWorkspaceMutation = useRemoveWorkspace();

  const [workspaceDialog, setWorkspaceDialog] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogInfo | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const keyboardNavRef = useRef(false);

  const projectCollapse = useCollapseState(PROJECTS_COLLAPSE_KEY);
  const labelCollapse = useCollapseState(LABELS_COLLAPSE_KEY);
  const pinnedCollapse = useCollapseState(PINNED_COLLAPSE_KEY);
  const { pinned: pinnedEntries, toggle: togglePinned } = usePinnedWorkspaces();

  // Two sensors so reorder works without an explicit "edit" toggle:
  //  • MouseSensor — desktop pointers can drag immediately; an 8px distance
  //    threshold avoids hijacking ordinary clicks on the project header.
  //  • TouchSensor — touch devices require a long-press (250ms) before drag
  //    activates so taps and scrolling still work normally on mobile.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  // Each pinned workspace is rendered exclusively in the Pinned section, so
  // we strip pinned worktrees out of the regular tree. Track which projects
  // had any pinned worktrees so SortableProject can hide the misleading
  // "No workspaces yet" copy when the only reason a project looks empty is
  // that everything got pinned.
  const { displayProjects, projectsWithPinned } = useMemo(() => {
    const withPinned = new Set<string>();
    const display = projects.map((p) => {
      const filtered = p.worktrees.filter((w) => !w.pinned);
      if (filtered.length !== p.worktrees.length) withPinned.add(p.name);
      return { ...p, worktrees: filtered };
    });
    return { displayProjects: display, projectsWithPinned: withPinned };
  }, [projects]);

  const pinnedSectionCollapsed = pinnedCollapse.isCollapsed(PINNED_SECTION_ID);
  const showPinnedSection = pinnedEntries.length > 0;
  const pinnedNavCount = showPinnedSection && !pinnedSectionCollapsed ? pinnedEntries.length : 0;

  const groups = useMemo(() => {
    if (labels.length === 0)
      return [
        {
          labelId: null as string | null,
          label: null as LabelDefinition | null,
          projects: displayProjects,
        },
      ];

    const byLabel = new Map<string | null, ProjectInfo[]>();
    for (const p of displayProjects) {
      const key = p.label ?? null;
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key)!.push(p);
    }

    const result: {
      labelId: string | null;
      label: LabelDefinition | null;
      projects: ProjectInfo[];
    }[] = [];
    for (const lbl of labels) {
      const grouped = byLabel.get(lbl.id);
      if (grouped) {
        result.push({ labelId: lbl.id, label: lbl, projects: grouped });
      }
    }
    const unlabeled = byLabel.get(null);
    if (unlabeled) {
      result.push({ labelId: null, label: null, projects: unlabeled });
    }
    return result;
  }, [displayProjects, labels]);

  const visibleGroups = useMemo(() => {
    if (!labelFilter) return groups;
    return groups.filter((g) => g.labelId === labelFilter);
  }, [groups, labelFilter]);

  // Only count workspaces that are actually rendered — collapsed
  // projects/labels hide their workspaces entirely, and keyboard arrow
  // navigation must skip over them so focus never lands on something the
  // user can't see. Pinned workspaces are always at the top of the list
  // (independent of label filter), then the regular tree follows.
  const allWorkspaceIds = useMemo(() => {
    const headerVisible = labels.length > 0 && !labelFilter;
    const pinnedPart = pinnedNavCount > 0 ? pinnedEntries.map((e) => e.workspaceId) : [];
    const rest = visibleGroups.flatMap((g) => {
      const groupKey = g.labelId ?? UNLABELED_KEY;
      if (headerVisible && labelCollapse.isCollapsed(groupKey)) return [];
      return g.projects.flatMap((p) => {
        if (projectCollapse.isCollapsed(p.name)) return [];
        return p.worktrees.map((wt) => toWorkspaceId(p.name, wt.branch));
      });
    });
    return [...pinnedPart, ...rest];
  }, [
    visibleGroups,
    labels.length,
    labelFilter,
    labelCollapse,
    projectCollapse,
    pinnedEntries,
    pinnedNavCount,
  ]);

  const workspaceIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    // Reserve slots [0..pinnedNavCount) for pinned workspaces so per-project
    // workspaceIndexStart values align with allWorkspaceIds.
    let index = pinnedNavCount;
    const headerVisible = labels.length > 0 && !labelFilter;
    for (const group of visibleGroups) {
      const groupKey = group.labelId ?? UNLABELED_KEY;
      if (headerVisible && labelCollapse.isCollapsed(groupKey)) continue;
      for (const project of group.projects) {
        map.set(project.name, index);
        if (!projectCollapse.isCollapsed(project.name)) {
          index += project.worktrees.length;
        }
      }
    }
    return map;
  }, [visibleGroups, labels.length, labelFilter, labelCollapse, projectCollapse, pinnedNavCount]);

  useEffect(() => {
    if (keyboardNavRef.current) return;
    if (activeWorkspaceId) {
      const idx = allWorkspaceIds.indexOf(activeWorkspaceId);
      setFocusedIndex(idx);
    } else {
      setFocusedIndex(-1);
    }
  }, [activeWorkspaceId, allWorkspaceIds]);

  // Reveal the active workspace in the tree by auto-expanding the project
  // and label group it belongs to. This should run ONLY when
  // activeWorkspaceId changes — i.e. when the user switches workspaces via
  // the Ctrl+R picker, URL nav, notifications, etc. After the initial
  // reveal we deliberately leave the collapse state alone so the user can
  // collapse the ancestors of the active workspace (via the "Collapse all"
  // toolbar button or by clicking a header) without this effect fighting
  // back on the very next render.
  //
  // The naive implementation would include only `activeWorkspaceId` in the
  // deps, but we also reference `labelCollapse`/`projectCollapse` inside
  // (their references change on every state update), `groups` (which we
  // walk), and `pinnedEntries` (for the pinned-workspace early-exit).
  // Including all of those in the deps makes the effect re-fire on every
  // collapse-state change and undo the user's collapse. To preserve the
  // "once per activeWorkspaceId" semantics while keeping the deps list
  // exhaustive, we gate the body behind a ref that remembers the last
  // revealed id — subsequent runs no-op until activeWorkspaceId actually
  // changes.
  //
  // We also clear keyboardNavRef so the focusedIndex effect above can
  // re-run and move the highlight ring to the freshly-revealed workspace.
  // Without that reset, arrow-key navigation followed by a Ctrl+R switch
  // would leave the highlight stuck on the old position.
  //
  // Pinned workspaces are rendered exclusively in the Pinned section at
  // the top of the tree (and are filtered out of `groups` via
  // `displayProjects`). They have no presence inside their project's
  // worktree list, so for a pinned active workspace we reveal it by
  // expanding the Pinned section header — not the project or label group
  // that contains its (now hidden) original entry.
  // Two refs so we run the reveal logic again when the *pinned-ness* of
  // the active workspace changes, not only when activeWorkspaceId itself
  // changes. Without the pinned-tracking ref, pinning or unpinning the
  // currently-active workspace early-returns here before
  // `pinnedCollapse.expand` (or the regular project/label expand) gets
  // a chance to run.
  const revealedWorkspaceRef = useRef<string | null>(null);
  const revealedAsPinnedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!activeWorkspaceId) {
      revealedWorkspaceRef.current = null;
      revealedAsPinnedRef.current = false;
      return;
    }
    const isActivePinned = pinnedEntries.some((e) => e.workspaceId === activeWorkspaceId);
    if (
      revealedWorkspaceRef.current === activeWorkspaceId &&
      revealedAsPinnedRef.current === isActivePinned
    ) {
      return;
    }
    revealedWorkspaceRef.current = activeWorkspaceId;
    revealedAsPinnedRef.current = isActivePinned;
    if (isActivePinned) {
      pinnedCollapse.expand(PINNED_SECTION_ID);
      keyboardNavRef.current = false;
      return;
    }
    for (const group of groups) {
      for (const project of group.projects) {
        const containsActive = project.worktrees.some(
          (wt) => toWorkspaceId(project.name, wt.branch) === activeWorkspaceId,
        );
        if (!containsActive) continue;
        if (labelFilter && group.labelId !== labelFilter) return;
        const headerVisible = labels.length > 0 && !labelFilter;
        if (headerVisible) {
          labelCollapse.expand(group.labelId ?? UNLABELED_KEY);
        }
        projectCollapse.expand(project.name);
        keyboardNavRef.current = false;
        return;
      }
    }
  }, [
    activeWorkspaceId,
    groups,
    labelFilter,
    labels.length,
    labelCollapse,
    projectCollapse,
    pinnedCollapse,
    pinnedEntries,
  ]);

  // Focus the container so keyboard navigation works immediately.
  // Depends on hasProjects because the container div only renders when
  // projects.length > 0 (see the early return below). On first mount with no
  // projects, containerRef.current is null; re-running when hasProjects flips
  // to true ensures we focus the container once it exists in the DOM.
  const hasProjects = projects.length > 0;
  useEffect(() => {
    if (hasProjects) {
      containerRef.current?.focus({ preventScroll: true });
    }
  }, [hasProjects]);

  const capabilities = useCapabilities();

  // ──────────────────────────────────────────────────────────────────────────
  // KEYBOARD NAVIGATION — READ BEFORE MODIFYING
  //
  // This handler is the backbone of keyboard workspace switching. It has
  // regressed multiple times because the interaction between this container-
  // level handler and the card-level onKeyDown (in WorkspaceCard) is subtle:
  //
  //  • Arrow keys update `focusedIndex` which controls the visual highlight
  //    ring on WorkspaceCards. However, arrow events may originate on a *child*
  //    card that has DOM focus (e.g. after the user clicked a card or tabbed
  //    into the list). They bubble up here because cards don't handle arrows.
  //
  //  • Enter on a *card* is handled by the card's own onKeyDown, which calls
  //    stopPropagation — so this container handler would NEVER see it.
  //    The card opens *itself*, not necessarily the keyboard-highlighted card.
  //
  //  • To fix this, arrow handlers explicitly re-focus the container via
  //    containerRef.current?.focus(). This guarantees the next Enter fires
  //    HERE, where we use the correct focusedIndex to open the right workspace.
  //
  // DO NOT remove the containerRef.current?.focus() calls. Without them,
  // pressing Enter after arrow-key navigation opens the wrong workspace (or
  // no workspace at all, depending on the platform).
  // ──────────────────────────────────────────────────────────────────────────
  const selectWorkspace = useCallback(
    (wsId: string) => {
      const href = capabilities.getWorkspaceHref?.(wsId);
      if (href && capabilities.navigate) {
        capabilities.navigate(href);
      } else {
        openWorkspace(wsId);
      }
    },
    [capabilities, openWorkspace],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (allWorkspaceIds.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      keyboardNavRef.current = true;
      setFocusedIndex((prev) => (prev < allWorkspaceIds.length - 1 ? prev + 1 : prev));
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
      if (focusedIndex >= 0 && focusedIndex < allWorkspaceIds.length) {
        keyboardNavRef.current = false;
        selectWorkspace(allWorkspaceIds[focusedIndex]);
      }
    }
  }

  const allProjectNames = useMemo(
    () => visibleGroups.flatMap((g) => g.projects.map((p) => p.name)),
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
      updateProjectLabelMutation.mutate({ name: activeId, label: targetLabelId });
      return;
    }

    const activeGroup = groups.find((g) => g.projects.some((p) => p.name === activeId));
    const overGroup = groups.find((g) => g.projects.some((p) => p.name === overId));

    if (!activeGroup || !overGroup) return;

    if (activeGroup.labelId === overGroup.labelId) {
      const allNames = projects.map((p) => p.name);
      const oldIndex = allNames.indexOf(activeId);
      const newIndex = allNames.indexOf(overId);
      reorderProjectsMutation.mutate(arrayMove(allNames, oldIndex, newIndex));
    } else {
      updateProjectLabelMutation.mutate({ name: activeId, label: overGroup.labelId });
    }
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-lg mb-2">No projects registered</p>
        <p className="text-sm">Click the + button to register a folder</p>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onPointerDown={() => {
          keyboardNavRef.current = false;
        }}
        className="flex flex-col gap-0.5 outline-none min-w-0"
      >
        {/* Pinned section — rendered outside DndContext/SortableContext so
            pinned workspaces cannot be touched by project drag-and-drop. It
            also ignores the label filter (pinned ws should always be
            visible) and is the *only* place pinned workspaces render. */}
        {showPinnedSection && (
          <div key="__pinned">
            <button
              type="button"
              onClick={() => pinnedCollapse.toggle(PINNED_SECTION_ID)}
              aria-expanded={!pinnedSectionCollapsed}
              className="flex h-9 w-full items-center gap-2 pl-3 pr-4 mb-0.5 text-left transition-colors hover:bg-primary/10 bg-accent"
            >
              <Pin className="size-3.5 -rotate-45 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground/80">Pinned</span>
              <ChevronRight
                className={`ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform ${
                  pinnedSectionCollapsed ? "" : "rotate-90"
                }`}
              />
            </button>
            {!pinnedSectionCollapsed && (
              <div className="flex flex-col gap-0.5 px-2">
                {pinnedEntries.map(({ project, worktree, workspaceId }, i) => (
                  <WorkspaceCard
                    key={workspaceId}
                    worktree={worktree}
                    projectName={project.name}
                    defaultBranch={project.defaultBranch}
                    projectKind={project.kind}
                    status={statuses.get(workspaceId)}
                    branchStatus={branchStatuses.get(workspaceId)}
                    setupStatus={setupStatuses.get(workspaceId)}
                    isFocused={i === focusedIndex}
                    onShowDeleteDialog={setDeleteDialog}
                    showProjectName
                    onTogglePinned={togglePinned}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={allProjectNames} strategy={verticalListSortingStrategy}>
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
                  {!groupCollapsed &&
                    group.projects.map((project) => (
                      <div key={project.name}>
                        <SortableProject
                          project={project}
                          statuses={statuses}
                          branchStatuses={branchStatuses}
                          setupStatuses={setupStatuses}
                          removeProject={(name) => removeProjectMutation.mutate(name)}
                          updateProjectLabel={(name, label) =>
                            updateProjectLabelMutation.mutate({ name, label })
                          }
                          promoteProjectToGit={(name) => promoteProjectToGitMutation.mutate(name)}
                          labels={labels}
                          setWorkspaceDialog={setWorkspaceDialog}
                          onShowDeleteDialog={setDeleteDialog}
                          focusedIndex={focusedIndex}
                          workspaceIndexStart={workspaceIndexMap.get(project.name) ?? 0}
                          collapsed={projectCollapse.isCollapsed(project.name)}
                          onToggleCollapse={projectCollapse.toggle}
                          hasPinnedSiblings={projectsWithPinned.has(project.name)}
                          onTogglePinned={togglePinned}
                        />
                      </div>
                    ))}
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
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">{activeDragId}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <NewWorkspaceDialog
        projectName={workspaceDialog ?? ""}
        open={workspaceDialog !== null}
        onOpenChange={(open) => setWorkspaceDialog(open ? workspaceDialog : null)}
      />

      <DeleteWorkspaceDialog
        open={deleteDialog !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDialog(null);
        }}
        onConfirm={() => {
          if (deleteDialog) {
            removeWorkspaceMutation.mutate({
              project: deleteDialog.projectName,
              branch: deleteDialog.branch,
            });
            setDeleteDialog(null);
          }
        }}
        branchName={deleteDialog?.branch ?? ""}
        isUnmerged={deleteDialog?.isUnmerged ?? false}
        isDirty={deleteDialog?.isDirty ?? false}
        hasUnpushedCommits={deleteDialog?.hasUnpushedCommits ?? false}
      />
    </>
  );
}
