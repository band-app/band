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
  ListMinus,
  Plus,
  Tag,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCapabilities } from "../context";
import {
  LABELS_COLLAPSE_KEY,
  PROJECTS_COLLAPSE_KEY,
  UNLABELED_KEY,
  useCollapseState,
} from "../hooks/use-collapse-state";
import {
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
  labels: LabelDefinition[];
  setWorkspaceDialog: (name: string | null) => void;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  focusedIndex: number;
  workspaceIndexStart: number;
  collapsed: boolean;
  onToggleCollapse: (name: string) => void;
}

function SortableProject({
  project,
  statuses,
  branchStatuses,
  setupStatuses,
  removeProject,
  updateProjectLabel,
  labels,
  setWorkspaceDialog,
  onShowDeleteDialog,
  focusedIndex,
  workspaceIndexStart,
  collapsed,
  onToggleCollapse,
}: SortableProjectProps) {
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

  let workspaceIndex = workspaceIndexStart;

  return (
    <div ref={setNodeRef} style={style} className="min-w-0 px-2">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* The header is a click/tap-to-toggle target on both desktop and
              mobile. We don't add tabIndex/keyboard handlers here because
              keyboard navigation lives one level down (workspace cards).
              Keyboard users can toggle collapse via the right-click context
              menu's Collapse/Expand entry, which is reachable with Shift+F10
              or the Menu key. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the context menu (see comment above) */}
          <div
            // touch-pan-y lets touch devices scroll the list vertically with
            // a finger over the project header — the TouchSensor still gets
            // long-presses (delay activation) but stops blocking page scroll.
            className="group flex items-center justify-between mb-0.5 px-1 select-none touch-pan-y"
            onClick={() => onToggleCollapse(project.name)}
          >
            {/* Drag listeners live on the title (folder icon + project name)
                so the project name itself is the drag handle. The 8px
                MouseSensor / 250ms TouchSensor thresholds mean a still
                click/tap bubbles up to the outer onClick (which toggles
                collapse) without starting a drag. */}
            <div
              className="flex items-center gap-2 min-w-0 cursor-grab"
              {...attributes}
              {...listeners}
            >
              {collapsed ? (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <h2 className="text-sm font-semibold text-foreground/80 truncate">
                    {project.name}
                  </h2>
                </TooltipTrigger>
                <TooltipContent side="top">{project.name}</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-1">
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
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onToggleCollapse(project.name)}>
            <ChevronRight className={collapsed ? "" : "rotate-90"} />
            {collapsed ? "Expand" : "Collapse"}
          </ContextMenuItem>
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

      {!collapsed && (
        <div className="flex flex-col gap-0.5 overflow-hidden">
          {project.worktrees.length === 0 ? (
            <p className="text-sm text-muted-foreground px-4 py-2">No workspaces yet</p>
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
                  status={statuses.get(wsId)}
                  branchStatus={branchStatuses.get(wsId)}
                  setupStatus={setupStatuses.get(wsId)}
                  isFocused={currentIndex === focusedIndex}
                  onShowDeleteDialog={onShowDeleteDialog}
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
      className={`flex h-9 w-full items-center gap-2 px-3 mb-0.5 text-left transition-colors hover:bg-primary/10 ${
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
      className={`flex h-9 w-full items-center gap-2 px-3 mb-0.5 text-left transition-colors hover:bg-primary/10 ${
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
  const removeWorkspaceMutation = useRemoveWorkspace();

  const [workspaceDialog, setWorkspaceDialog] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogInfo | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const keyboardNavRef = useRef(false);

  const projectCollapse = useCollapseState(PROJECTS_COLLAPSE_KEY);
  const labelCollapse = useCollapseState(LABELS_COLLAPSE_KEY);

  // Two sensors so reorder works without an explicit "edit" toggle:
  //  • MouseSensor — desktop pointers can drag immediately; an 8px distance
  //    threshold avoids hijacking ordinary clicks on the project header.
  //  • TouchSensor — touch devices require a long-press (250ms) before drag
  //    activates so taps and scrolling still work normally on mobile.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const groups = useMemo(() => {
    if (labels.length === 0)
      return [{ labelId: null as string | null, label: null as LabelDefinition | null, projects }];

    const byLabel = new Map<string | null, ProjectInfo[]>();
    for (const p of projects) {
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
  }, [projects, labels]);

  const visibleGroups = useMemo(() => {
    if (!labelFilter) return groups;
    return groups.filter((g) => g.labelId === labelFilter);
  }, [groups, labelFilter]);

  // Only count workspaces that are actually rendered — collapsed
  // projects/labels hide their workspaces entirely, and keyboard arrow
  // navigation must skip over them so focus never lands on something the
  // user can't see.
  const allWorkspaceIds = useMemo(() => {
    const headerVisible = labels.length > 0 && !labelFilter;
    return visibleGroups.flatMap((g) => {
      const groupKey = g.labelId ?? UNLABELED_KEY;
      if (headerVisible && labelCollapse.isCollapsed(groupKey)) return [];
      return g.projects.flatMap((p) => {
        if (projectCollapse.isCollapsed(p.name)) return [];
        return p.worktrees.map((wt) => toWorkspaceId(p.name, wt.branch));
      });
    });
  }, [visibleGroups, labels.length, labelFilter, labelCollapse, projectCollapse]);

  const workspaceIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
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
  }, [visibleGroups, labels.length, labelFilter, labelCollapse, projectCollapse]);

  useEffect(() => {
    if (keyboardNavRef.current) return;
    if (activeWorkspaceId) {
      const idx = allWorkspaceIds.indexOf(activeWorkspaceId);
      setFocusedIndex(idx);
    } else {
      setFocusedIndex(-1);
    }
  }, [activeWorkspaceId, allWorkspaceIds]);

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
        <p className="text-sm">Click the + button to register a git repository</p>
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={allProjectNames} strategy={verticalListSortingStrategy}>
            {visibleGroups.map((group, groupIndex) => {
              const groupKey = group.labelId ?? UNLABELED_KEY;
              // When a label filter is active we render a single group without
              // a header, so honour the group's collapsed state only when the
              // header is visible (otherwise users would have no way to expand
              // it again). Same for the no-labels mode.
              const headerVisible = labels.length > 0 && !labelFilter;
              const groupCollapsed = headerVisible && labelCollapse.isCollapsed(groupKey);
              return (
                <div key={groupKey}>
                  {groupIndex > 0 && !labels.length && (
                    <hr className="border-border mt-1 mb-0.5 mx-2" />
                  )}
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
                    group.projects.map((project, index) => (
                      <div key={project.name}>
                        {index > 0 && <hr className="border-border mt-1 mb-0.5 mx-2" />}
                        <SortableProject
                          project={project}
                          statuses={statuses}
                          branchStatuses={branchStatuses}
                          setupStatuses={setupStatuses}
                          removeProject={(name) => removeProjectMutation.mutate(name)}
                          updateProjectLabel={(name, label) =>
                            updateProjectLabelMutation.mutate({ name, label })
                          }
                          labels={labels}
                          setWorkspaceDialog={setWorkspaceDialog}
                          onShowDeleteDialog={setDeleteDialog}
                          focusedIndex={focusedIndex}
                          workspaceIndexStart={workspaceIndexMap.get(project.name) ?? 0}
                          collapsed={projectCollapse.isCollapsed(project.name)}
                          onToggleCollapse={projectCollapse.toggle}
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
