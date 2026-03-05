import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceCard } from "./WorkspaceCard";

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

export function DashboardView() {
  const [projects, setProjects] = useState<ProjectWithWorktrees[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const projectNames = useMemo(() => projects.map((p) => p.name), [projects]);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to fetch projects");
      const data = (await res.json()) as { projects: ProjectWithWorktrees[] };
      setProjects(data.projects);
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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = projectNames.indexOf(active.id as string);
    const newIndex = projectNames.indexOf(over.id as string);
    const newOrder = arrayMove(projectNames, oldIndex, newIndex);

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
      // Revert on failure by re-fetching
      fetchProjects();
    });
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
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={projectNames} strategy={verticalListSortingStrategy}>
          {projects.map((project, index) => (
            <div key={project.name}>
              {index > 0 && <hr className="border-border mb-2" />}
              <SortableProject project={project} />
            </div>
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}
