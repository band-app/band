import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useCapabilities } from "../context";
import { NewTaskDialog, type NewTaskProject } from "./NewTaskDialog";

type ProjectList = Awaited<ReturnType<typeof trpc.projects.list.query>>;
type Project = ProjectList["projects"][number];

const POLL_MS = 4000;

/** The default project is named "personal"; show it capitalized. */
const projectTitle = (p: { name: string; isDefault?: boolean }) =>
  p.isDefault ? `${p.name.charAt(0).toUpperCase()}${p.name.slice(1)}` : p.name;

export const taskHref = (taskId: string) => `/task/${encodeURIComponent(taskId)}`;

/**
 * The sidebar's projects: each with its coordinator and the tasks that have a folder. A task that
 * predates folders is a worktree and stays under its repo.
 */
export function ProjectTaskList({
  onOpenCoordinator,
}: {
  onOpenCoordinator: (projectId: string) => void;
}) {
  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query(),
    refetchInterval: POLL_MS,
  });
  const list = projects.data?.projects ?? [];
  if (list.length === 0) return null;
  return (
    <section className="px-2 pb-2" data-testid="project-tasks">
      {list.map((p) => (
        <ProjectBlock key={p.id} project={p} onOpenCoordinator={onOpenCoordinator} />
      ))}
    </section>
  );
}

function ProjectBlock({
  project,
  onOpenCoordinator,
}: {
  project: Project;
  onOpenCoordinator: (projectId: string) => void;
}) {
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({
    queryKey: ["projectTasks.list", project.id],
    queryFn: async () => (await trpc.projectTasks.list.query({ project: project.id })).tasks,
    refetchInterval: POLL_MS,
  });
  const folderTasks = (tasks.data ?? []).filter((t) => t.briefPath !== null);
  const forDialog: NewTaskProject = {
    id: project.id,
    name: project.name,
    repos: project.repos.map((r) => ({ repo: r.repo, role: r.role ?? null })),
  };
  const open = (taskId: string) => capabilities.navigate?.(taskHref(taskId));

  return (
    <div className="mt-2" data-testid="project-tasks__project" data-project={project.name}>
      <div className="flex items-center justify-between px-2 py-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FolderKanban className="size-3.5" />
          <span data-testid="project-tasks__project-name">{projectTitle(project)}</span>
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={`New task in ${project.name}`}
          data-testid="project-tasks__new-task"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      {project.coordinator ? (
        <button
          type="button"
          data-testid="project-tasks__coordinator"
          className="flex w-full items-center gap-1.5 rounded-md px-4 py-1 text-left text-sm hover:bg-muted"
          onClick={() => onOpenCoordinator(project.id)}
        >
          Coordinator
        </button>
      ) : null}
      {folderTasks.map((t) => (
        <button
          key={t.id}
          type="button"
          data-testid="project-tasks__task"
          data-task={t.name}
          data-task-id={t.id}
          className="flex w-full items-center gap-1.5 rounded-md px-4 py-1 text-left text-sm hover:bg-muted"
          onClick={() => open(t.id)}
        >
          <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{t.name}</span>
        </button>
      ))}
      <NewTaskDialog
        project={forDialog}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(task) => {
          void queryClient.invalidateQueries({ queryKey: ["projectTasks.list", project.id] });
          open(task.id);
        }}
      />
    </div>
  );
}
