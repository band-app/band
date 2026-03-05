import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Clipboard, Ellipsis, FolderOpen, ListMinus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NewWorkspaceDialog } from "@/components/NewWorkspaceForm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceCard } from "@/components/WorkspaceCard";
import {
  useDashboardStore,
  type ProjectInfo,
  type WorkspaceStatus,
  type WorkspaceBranchStatus,
} from "@/stores/dashboard-store";

interface SortableProjectProps {
  project: ProjectInfo;
  statuses: Map<string, WorkspaceStatus>;
  branchStatuses: Map<string, WorkspaceBranchStatus>;
  removeProject: (name: string) => void;
  workspaceDialog: string | null;
  setWorkspaceDialog: (name: string | null) => void;
  focusedIndex: number;
  workspaceIndexStart: number;
}

function SortableProject({
  project,
  statuses,
  branchStatuses,
  removeProject,
  workspaceDialog,
  setWorkspaceDialog,
  focusedIndex,
  workspaceIndexStart,
}: SortableProjectProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.name,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  let workspaceIndex = workspaceIndexStart;

  return (
    <div ref={setNodeRef} style={style} className="min-w-0">
      <div className="flex items-center justify-between mb-1 px-1">
        <div
          className="flex items-center gap-2 min-w-0 cursor-grab touch-none"
          {...attributes}
          {...listeners}
        >
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground truncate">{project.name}</h2>
        </div>
        <div className="flex items-center gap-1">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigator.clipboard.writeText(project.path)}>
                <Clipboard />
                Copy path
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  import("@tauri-apps/api/core").then(({ invoke }) =>
                    invoke("reveal_in_finder", { path: project.path }),
                  );
                }}
              >
                <FolderOpen />
                Open in Finder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => removeProject(project.name)}>
                <ListMinus />
                Remove from list
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <NewWorkspaceDialog
        projectName={project.name}
        open={workspaceDialog === project.name}
        onOpenChange={(open) => setWorkspaceDialog(open ? project.name : null)}
      />

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
              />
            );
          })
        )}
      </div>
    </div>
  );
}

export function ProjectList() {
  const projects = useDashboardStore((s) => s.projects);
  const statuses = useDashboardStore((s) => s.statuses);
  const branchStatuses = useDashboardStore((s) => s.branchStatuses);
  const removeProject = useDashboardStore((s) => s.removeProject);
  const reorderProjects = useDashboardStore((s) => s.reorderProjects);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const [workspaceDialog, setWorkspaceDialog] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const projectNames = useMemo(() => projects.map((p) => p.name), [projects]);

  const allWorkspaceIds = useMemo(
    () =>
      projects.flatMap((project) => project.worktrees.map((wt) => `${project.name}-${wt.branch}`)),
    [projects],
  );

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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = projectNames.indexOf(active.id as string);
    const newIndex = projectNames.indexOf(over.id as string);
    const newOrder = arrayMove(projectNames, oldIndex, newIndex);
    reorderProjects(newOrder);
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-lg mb-2">No projects registered</p>
        <p className="text-sm">Click the + button to register a git repository</p>
      </div>
    );
  }

  // Pre-compute workspace index offsets for each project
  const workspaceIndexStarts: number[] = [];
  let runningIndex = 0;
  for (const project of projects) {
    workspaceIndexStarts.push(runningIndex);
    runningIndex += project.worktrees.length;
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex flex-col gap-2 outline-none min-w-0"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={projectNames} strategy={verticalListSortingStrategy}>
          {projects.map((project, index) => (
            <div key={project.name}>
              {index > 0 && <hr className="border-border mb-2" />}
              <SortableProject
                project={project}
                statuses={statuses}
                branchStatuses={branchStatuses}
                removeProject={removeProject}
                workspaceDialog={workspaceDialog}
                setWorkspaceDialog={setWorkspaceDialog}
                focusedIndex={focusedIndex}
                workspaceIndexStart={workspaceIndexStarts[index]}
              />
            </div>
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}
