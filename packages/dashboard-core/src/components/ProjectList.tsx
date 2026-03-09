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
} from "@band/ui";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
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
import { Check, Clipboard, FolderOpen, ListMinus, Plus, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCapabilities } from "../context";
import {
  useRemoveProject,
  useRemoveWorkspace,
  useReorderProjects,
  useUpdateProjectLabel,
} from "../hooks/use-project-mutations";
import { useProjects } from "../hooks/use-projects";
import { useSettingsQuery } from "../hooks/use-settings-query";
import { useDashboardStore } from "../stores/index";
import type {
  DeleteDialogInfo,
  LabelDefinition,
  ProjectInfo,
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
  removeProject: (name: string) => void;
  updateProjectLabel: (name: string, label: string | null) => void;
  labels: LabelDefinition[];
  setWorkspaceDialog: (name: string | null) => void;
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  focusedIndex: number;
  workspaceIndexStart: number;
}

function SortableProject({
  project,
  statuses,
  branchStatuses,
  removeProject,
  updateProjectLabel,
  labels,
  setWorkspaceDialog,
  onShowDeleteDialog,
  focusedIndex,
  workspaceIndexStart,
}: SortableProjectProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.name,
  });
  const capabilities = useCapabilities();

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  let workspaceIndex = workspaceIndexStart;

  return (
    <div ref={setNodeRef} style={style} className="min-w-0 px-2">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center justify-between mb-1 px-1">
            <div
              className="flex items-center gap-2 min-w-0 cursor-grab touch-none"
              {...attributes}
              {...listeners}
            >
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground truncate">{project.name}</h2>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setWorkspaceDialog(project.name)}
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add workspace</TooltipContent>
            </Tooltip>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
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

      <div className="flex flex-col gap-0.5 overflow-hidden">
        {project.worktrees.length === 0 ? (
          <p className="text-sm text-muted-foreground px-4 py-2">No workspaces yet</p>
        ) : (
          project.worktrees.map((wt) => {
            const wsId = `${project.name}-${wt.branch}`;
            const currentIndex = workspaceIndex++;
            return (
              <WorkspaceCard
                key={wt.branch}
                worktree={wt}
                projectName={project.name}
                defaultBranch={project.defaultBranch}
                status={statuses.get(wsId)}
                branchStatus={branchStatuses.get(wsId)}
                isFocused={currentIndex === focusedIndex}
                onShowDeleteDialog={onShowDeleteDialog}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function DroppableLabelHeader({ labelId, label }: { labelId: string; label: LabelDefinition }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${labelId}` });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 px-3 py-2.5 mb-1 transition-colors ${isOver ? "bg-primary/20" : "bg-accent"}`}
    >
      <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
      <span className="text-sm font-semibold text-foreground/80">{label.name}</span>
    </div>
  );
}

function DroppableUnlabeledHeader() {
  const { setNodeRef, isOver } = useDroppable({ id: "group:__unlabeled" });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 px-3 py-2.5 mb-1 transition-colors ${isOver ? "bg-primary/20" : "bg-accent"}`}
    >
      <span className="text-sm font-semibold text-foreground/80">Unlabeled</span>
    </div>
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

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

  const allWorkspaceIds = useMemo(
    () =>
      visibleGroups.flatMap((g) =>
        g.projects.flatMap((p) => p.worktrees.map((wt) => `${p.name}-${wt.branch}`)),
      ),
    [visibleGroups],
  );

  const workspaceIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const group of visibleGroups) {
      for (const project of group.projects) {
        map.set(project.name, index);
        index += project.worktrees.length;
      }
    }
    return map;
  }, [visibleGroups]);

  useEffect(() => {
    if (activeWorkspaceId) {
      const idx = allWorkspaceIds.indexOf(activeWorkspaceId);
      setFocusedIndex(idx);
    } else {
      setFocusedIndex(-1);
    }
  }, [activeWorkspaceId, allWorkspaceIds]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (allWorkspaceIds.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev < allWorkspaceIds.length - 1 ? prev + 1 : prev));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else if (e.key === "Enter") {
      if (focusedIndex >= 0 && focusedIndex < allWorkspaceIds.length) {
        openWorkspace(allWorkspaceIds[focusedIndex]);
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
        className="flex flex-col gap-1 outline-none min-w-0"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={allProjectNames} strategy={verticalListSortingStrategy}>
            {visibleGroups.map((group, groupIndex) => (
              <div key={group.labelId ?? "__unlabeled"}>
                {groupIndex > 0 && !labels.length && <hr className="border-border my-1 mx-2" />}
                {labels.length > 0 &&
                  !labelFilter &&
                  (group.label ? (
                    <DroppableLabelHeader labelId={group.labelId!} label={group.label} />
                  ) : (
                    <DroppableUnlabeledHeader />
                  ))}
                {group.projects.map((project, index) => (
                  <div key={project.name}>
                    {index > 0 && <hr className="border-border mb-1 mx-2" />}
                    <SortableProject
                      project={project}
                      statuses={statuses}
                      branchStatuses={branchStatuses}
                      removeProject={(name) => removeProjectMutation.mutate(name)}
                      updateProjectLabel={(name, label) =>
                        updateProjectLabelMutation.mutate({ name, label })
                      }
                      labels={labels}
                      setWorkspaceDialog={setWorkspaceDialog}
                      onShowDeleteDialog={setDeleteDialog}
                      focusedIndex={focusedIndex}
                      workspaceIndexStart={workspaceIndexMap.get(project.name) ?? 0}
                    />
                  </div>
                ))}
              </div>
            ))}
          </SortableContext>
          <DragOverlay>
            {activeDragId ? (
              <div className="flex items-center gap-2 px-1 py-1 bg-background rounded shadow-lg border">
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
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
