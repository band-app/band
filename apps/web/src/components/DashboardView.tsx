import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderOpen, Loader2, RefreshCw, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceCard } from "./WorkspaceCard";

interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

interface AgentInfo {
  name: string;
  status: string;
  lastActivity: string;
}

interface WorktreeWithStatus {
  branch: string;
  path: string;
  head?: string;
  workspaceId: string;
  agent: AgentInfo | null;
}

interface ProjectWithWorktrees {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeWithStatus[];
  label?: string;
}

interface StatusEvent {
  kind: "update" | "remove" | "snapshot";
  status?: {
    workspaceId: string;
    agent?: AgentInfo;
  };
  statuses?: Array<{
    workspaceId: string;
    agent?: AgentInfo;
  }>;
  workspaceId?: string;
}

interface LabelGroup {
  labelId: string | null;
  label: LabelDefinition | null;
  projects: ProjectWithWorktrees[];
}

function SortableProject({ project }: { project: ProjectWithWorktrees }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.name,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="min-w-0">
      <div
        className="flex items-center gap-2 mb-1 px-1 cursor-grab touch-none"
        {...attributes}
        {...listeners}
      >
        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground truncate">{project.name}</h2>
      </div>
      <div className="flex flex-col gap-0.5 overflow-hidden">
        {project.worktrees.map((wt) => (
          <WorkspaceCard
            key={wt.workspaceId}
            workspaceId={wt.workspaceId}
            branch={wt.branch}
            agent={wt.agent}
          />
        ))}
      </div>
    </div>
  );
}

function DroppableLabelHeader({ labelId, label }: { labelId: string; label: LabelDefinition }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${labelId}` });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 px-2 py-1.5 mb-1 rounded-md transition-colors ${isOver ? "bg-primary/20 ring-1 ring-primary/40" : "bg-accent"}`}
    >
      <span
        className="size-2.5 rounded-full shrink-0"
        style={{ backgroundColor: label.color }}
      />
      <span className="text-sm font-semibold text-foreground/80">{label.name}</span>
    </div>
  );
}

function DroppableUnlabeledHeader() {
  const { setNodeRef, isOver } = useDroppable({ id: "group:__unlabeled" });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 px-2 py-1.5 mb-1 rounded-md transition-colors ${isOver ? "bg-primary/20 ring-1 ring-primary/40" : "bg-accent"}`}
    >
      <span className="text-sm font-semibold text-foreground/80">Unlabeled</span>
    </div>
  );
}

export function DashboardView() {
  const [projects, setProjects] = useState<ProjectWithWorktrees[]>([]);
  const [labels, setLabels] = useState<LabelDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Group projects by label, labels in definition order, unlabeled at bottom
  const groups = useMemo((): LabelGroup[] => {
    if (labels.length === 0) return [{ labelId: null, label: null, projects }];

    const byLabel = new Map<string | null, ProjectWithWorktrees[]>();
    for (const p of projects) {
      const key = p.label ?? null;
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key)!.push(p);
    }

    const result: LabelGroup[] = [];
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

  // When labelFilter is set, only show that label's group
  const visibleGroups = useMemo(() => {
    if (!labelFilter) return groups;
    return groups.filter((g) => g.labelId === labelFilter);
  }, [groups, labelFilter]);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to fetch projects");
      const data = (await res.json()) as { projects: ProjectWithWorktrees[]; labels: LabelDefinition[] };
      setProjects(data.projects);
      setLabels(data.labels);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch projects on mount
  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // SSE for real-time status updates
  useEffect(() => {
    const es = new EventSource("/api/status/stream");
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as StatusEvent;
        if (data.kind === "snapshot" && data.statuses) {
          // Update all statuses from snapshot
          setProjects((prev) =>
            prev.map((project) => ({
              ...project,
              worktrees: project.worktrees.map((wt) => {
                const match = data.statuses!.find((s) => s.workspaceId === wt.workspaceId);
                return match ? { ...wt, agent: match.agent ?? null } : wt;
              }),
            })),
          );
        } else if (data.kind === "update" && data.status) {
          setProjects((prev) =>
            prev.map((project) => ({
              ...project,
              worktrees: project.worktrees.map((wt) =>
                wt.workspaceId === data.status!.workspaceId
                  ? { ...wt, agent: data.status!.agent ?? null }
                  : wt,
              ),
            })),
          );
        } else if (data.kind === "remove" && data.workspaceId) {
          setProjects((prev) =>
            prev.map((project) => ({
              ...project,
              worktrees: project.worktrees.map((wt) =>
                wt.workspaceId === data.workspaceId ? { ...wt, agent: null } : wt,
              ),
            })),
          );
        }
      } catch {
        // Skip malformed events
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  // All project names in visual order for the single SortableContext
  const allProjectNames = useMemo(
    () => visibleGroups.flatMap((g) => g.projects.map((p) => p.name)),
    [visibleGroups],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(event.active.id as string);
  }

  function updateProjectLabel(name: string, label: string | null) {
    // Optimistic update
    setProjects((prev) =>
      prev.map((p) =>
        p.name === name
          ? { ...p, label: label ?? undefined }
          : p,
      ),
    );

    fetch("/api/projects/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, label }),
    }).catch(() => {
      fetchProjects();
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Dropped on a label header
    if (overId.startsWith("group:")) {
      const targetLabelId = overId === "group:__unlabeled" ? null : overId.slice("group:".length);
      updateProjectLabel(activeId, targetLabelId);
      return;
    }

    // Dropped on another project — find which groups they belong to
    const activeGroup = groups.find((g) => g.projects.some((p) => p.name === activeId));
    const overGroup = groups.find((g) => g.projects.some((p) => p.name === overId));

    if (!activeGroup || !overGroup) return;

    if (activeGroup.labelId === overGroup.labelId) {
      // Same group — reorder
      const allNames = projects.map((p) => p.name);
      const oldIndex = allNames.indexOf(activeId);
      const newIndex = allNames.indexOf(overId);
      const newOrder = arrayMove(allNames, oldIndex, newIndex);

      // Optimistic reorder
      setProjects((prev) => {
        const map = new Map(prev.map((p) => [p.name, p]));
        return newOrder.map((name) => map.get(name)!);
      });

      // Persist
      fetch("/api/projects/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: newOrder }),
      }).catch(() => {
        fetchProjects();
      });
    } else {
      // Different group — change label to target group's label
      updateProjectLabel(activeId, overGroup.labelId);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchProjects}
          className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-sm hover:bg-secondary/80"
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FolderOpen className="size-10 text-muted-foreground" />
        <div>
          <p className="font-medium">No projects</p>
          <p className="text-sm text-muted-foreground">
            Add a project in the Band dashboard to get started
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={allProjectNames} strategy={verticalListSortingStrategy}>
          {visibleGroups.map((group, groupIndex) => (
            <div key={group.labelId ?? "__unlabeled"}>
              {groupIndex > 0 && <hr className="border-border my-2" />}
              {labels.length > 0 && !labelFilter && (
                group.label ? (
                  <DroppableLabelHeader labelId={group.labelId!} label={group.label} />
                ) : (
                  <DroppableUnlabeledHeader />
                )
              )}
              {group.projects.map((project, index) => (
                <div key={project.name}>
                  {index > 0 && <hr className="border-border mb-2" />}
                  <SortableProject project={project} />
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

      {labels.length > 0 && (
        <div className="flex items-center gap-1.5 px-1 pt-2 border-t border-border">
          <button
            type="button"
            onClick={() => setLabelFilter(null)}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors ${
              !labelFilter
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <Tag className="size-3" />
            All
          </button>
          {labels.map((lbl) => (
            <button
              key={lbl.id}
              type="button"
              onClick={() => setLabelFilter((prev) => (prev === lbl.id ? null : lbl.id))}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors ${
                labelFilter === lbl.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: lbl.color }}
              />
              {lbl.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
