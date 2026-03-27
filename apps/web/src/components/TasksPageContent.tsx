import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@band-app/ui";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  ListTodo,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { trpc } from "../lib/trpc-client";

interface TaskRecord {
  id: string;
  workspaceId: string;
  project: string;
  branch: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  sessionId?: string;
  startedAt: number;
  completedAt?: number;
}

interface ProjectInfo {
  name: string;
  worktrees: { branch: string }[];
}

function relativeTime(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatDuration(startedAt: number, completedAt?: number): string {
  const end = completedAt ?? Date.now();
  const ms = end - startedAt;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

type StatusFilter = "all" | "running" | "completed" | "failed";

export function TasksPageContent() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showNewTask, setShowNewTask] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tasksData = await trpc.tasks.list.query({});
      setTasks(tasksData.tasks as TaskRecord[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (projectFilter !== "all" && task.project !== projectFilter) return false;
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      return true;
    });
  }, [tasks, projectFilter, statusFilter]);

  const projectNames = useMemo(() => {
    const names = new Set(tasks.map((t) => t.project).filter(Boolean));
    return Array.from(names).sort();
  }, [tasks]);

  const handleNewTaskSubmit = useCallback(
    async (workspaceId: string, prompt: string, mode?: string) => {
      await trpc.tasks.submit.mutate({ workspaceId, prompt, mode });
      setShowNewTask(false);
      await fetchData();
    },
    [fetchData],
  );

  return (
    <div className="flex flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="All Projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Projects</SelectItem>
            {projectNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            {(["all", "running", "completed", "failed"] as const).map((status) => (
              <SelectItem key={status} value={status} className="capitalize">
                {status === "all" ? "All Statuses" : status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={fetchData}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <Button
            variant="outline"
            size="xs"
            className="hidden sm:inline-flex"
            onClick={() => setShowNewTask(true)}
          >
            <Plus className="size-3" />
            New Task
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            className="sm:hidden"
            onClick={() => setShowNewTask(true)}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {loading && tasks.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="secondary" size="sm" onClick={fetchData}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && filteredTasks.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <ListTodo className="size-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No tasks found</p>
              <p className="text-sm text-muted-foreground">
                {tasks.length > 0
                  ? "Try adjusting your filters"
                  : "Dispatch a new task to get started"}
              </p>
            </div>
          </div>
        )}

        {filteredTasks.length > 0 && (
          <div className="flex flex-col gap-2 p-4">
            {filteredTasks.map((task) => (
              <TaskCard key={task.id} task={task} onAction={fetchData} />
            ))}
          </div>
        )}
      </main>

      <NewTaskDialog
        open={showNewTask}
        onOpenChange={setShowNewTask}
        onSubmit={handleNewTaskSubmit}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: TaskRecord["status"] }) {
  switch (status) {
    case "running":
      return (
        <Badge variant="secondary" className="gap-1.5">
          <Loader2 className="size-3 animate-spin" />
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="secondary" className="gap-1.5 text-green-600 dark:text-green-400">
          <CheckCircle2 className="size-3" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1.5">
          <AlertCircle className="size-3" />
          Failed
        </Badge>
      );
  }
}

function TaskCard({ task, onAction }: { task: TaskRecord; onAction: () => void }) {
  const sessionHref = task.sessionId
    ? `/workspace/${encodeURIComponent(task.workspaceId)}`
    : undefined;
  const [acting, setActing] = useState(false);

  const handleCancel = useCallback(async () => {
    setActing(true);
    try {
      await trpc.tasks.cancel.mutate({ taskId: task.id });
      onAction();
    } catch {
      // Ignore — task may have already finished
      onAction();
    } finally {
      setActing(false);
    }
  }, [task.id, onAction]);

  const handleRerun = useCallback(async () => {
    setActing(true);
    try {
      await trpc.tasks.rerun.mutate({ taskId: task.id });
      onAction();
    } catch {
      // Ignore — workspace may already have a running task
      onAction();
    } finally {
      setActing(false);
    }
  }, [task.id, onAction]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-3">
        <p className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-foreground">
          {task.prompt}
        </p>
        <div className="flex items-center gap-2">
          {task.status === "running" && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={handleCancel}
              disabled={acting}
              title="Cancel task"
            >
              {acting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <XCircle className="size-3.5" />
              )}
            </Button>
          )}
          {(task.status === "completed" || task.status === "failed") && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={handleRerun}
              disabled={acting}
              title="Re-run task"
            >
              {acting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
            </Button>
          )}
          <StatusBadge status={task.status} />
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/70">
          {task.project}/{task.branch}
        </span>
        <span className="text-border">·</span>
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" />
          {relativeTime(task.startedAt)}
        </span>
        <span className="text-border">·</span>
        <span>{formatDuration(task.startedAt, task.completedAt)}</span>
        {sessionHref && (
          <>
            <span className="text-border">·</span>
            <Link
              to={sessionHref}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="size-3" />
              Session
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

interface AgentMode {
  id: string;
  name: string;
  description?: string;
}

function NewTaskDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (workspaceId: string, prompt: string, mode?: string) => Promise<void>;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [selectedMode, setSelectedMode] = useState<string>("");
  const [modes, setModes] = useState<AgentMode[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const workspaceId =
    selectedProject && selectedBranch ? `${selectedProject}-${selectedBranch}` : "";

  useEffect(() => {
    if (open) {
      setSelectedProject("");
      setSelectedBranch("");
      setPrompt("");
      setSelectedMode("");
      setModes([]);
      setSubmitError(null);
      trpc.projects.list.query().then((data) => {
        setProjects(data.projects as ProjectInfo[]);
      });
    }
  }, [open]);

  useEffect(() => {
    if (workspaceId) {
      trpc.modes.list.query({ workspaceId }).then((data) => {
        setModes(data.modes as AgentMode[]);
        setSelectedMode("");
      });
    } else {
      setModes([]);
      setSelectedMode("");
    }
  }, [workspaceId]);

  const branches = useMemo(() => {
    const project = projects.find((p) => p.name === selectedProject);
    return project?.worktrees.map((w) => w.branch) ?? [];
  }, [projects, selectedProject]);

  const handleProjectChange = useCallback((value: string) => {
    setSelectedProject(value);
    setSelectedBranch("");
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!workspaceId || !prompt.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(workspaceId, prompt.trim(), selectedMode || undefined);
      setSelectedProject("");
      setSelectedBranch("");
      setPrompt("");
      setSelectedMode("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to submit task");
    } finally {
      setSubmitting(false);
    }
  }, [workspaceId, prompt, selectedMode, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
          <DialogDescription>Dispatch a new task to a coding agent</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="project-select">
              Project
            </label>
            <Select value={selectedProject} onValueChange={handleProjectChange}>
              <SelectTrigger id="project-select">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="branch-select">
              Workspace
            </label>
            <Select
              value={selectedBranch}
              onValueChange={setSelectedBranch}
              disabled={!selectedProject}
            >
              <SelectTrigger id="branch-select">
                <SelectValue
                  placeholder={selectedProject ? "Select a workspace" : "Select a project first"}
                />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {modes.length > 0 && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="mode-select">
                Mode
              </label>
              <Select value={selectedMode} onValueChange={setSelectedMode}>
                <SelectTrigger id="mode-select">
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  {modes.map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>
                      {mode.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="task-prompt">
              Prompt
            </label>
            <Textarea
              id="task-prompt"
              placeholder="Describe what the agent should do..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </div>

          {submitError && <p className="text-sm text-destructive">{submitError}</p>}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={handleSubmit} disabled={!workspaceId || !prompt.trim() || submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            Submit Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
