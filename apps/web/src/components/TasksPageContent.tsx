import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
  ChevronRight,
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
  mode?: string;
  model?: string;
  codingAgentId?: string;
  workspaceExists?: boolean;
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
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);

  useEffect(() => {
    trpc.settings.get.query().then((settings) => {
      const raw = (settings as Record<string, unknown>).codingAgents;
      const codingAgents = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
      setAgents(codingAgents);
    });
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, CodingAgentDef>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

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
    async (
      workspaceId: string,
      prompt: string,
      mode?: string,
      model?: string,
      codingAgentId?: string,
    ) => {
      await trpc.tasks.submit.mutate({ workspaceId, prompt, mode, model, codingAgentId });
      setShowNewTask(false);
      await fetchData();
    },
    [fetchData],
  );

  return (
    <div className="flex flex-col overflow-hidden" data-testid="tasks__root">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="h-8 w-40 text-xs" data-testid="tasks__project-filter">
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
          <SelectTrigger className="h-8 w-40 text-xs" data-testid="tasks__status-filter">
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
            data-testid="tasks__new-task-button"
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
          <div
            className="flex flex-col items-center justify-center gap-3 py-16 text-center"
            data-testid="tasks__empty-state"
          >
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
              <TaskCard key={task.id} task={task} onAction={fetchData} agentMap={agentMap} />
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
        <Badge variant="secondary" className="gap-1.5" data-testid="tasks__status-badge--running">
          <Loader2 className="size-3 animate-spin" />
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge
          variant="secondary"
          className="gap-1.5 text-green-600 dark:text-green-400"
          data-testid="tasks__status-badge--completed"
        >
          <CheckCircle2 className="size-3" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1.5" data-testid="tasks__status-badge--failed">
          <AlertCircle className="size-3" />
          Failed
        </Badge>
      );
  }
}

function TaskCard({
  task,
  onAction,
  agentMap,
}: {
  task: TaskRecord;
  onAction: () => void;
  agentMap: Map<string, CodingAgentDef>;
}) {
  const sessionHref =
    task.sessionId && task.workspaceExists
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
    <div
      className="flex flex-col gap-2 rounded-lg border-2 border-border/50 p-4 transition-colors hover:border-border"
      data-testid={`tasks__card--${task.id}`}
    >
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

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
        {task.codingAgentId && (
          <>
            <span className="text-border">·</span>
            <span>{agentMap.get(task.codingAgentId)?.label ?? task.codingAgentId}</span>
          </>
        )}
        {task.model && (
          <>
            <span className="text-border">·</span>
            <span>{task.model}</span>
          </>
        )}
        {task.mode && (
          <>
            <span className="text-border">·</span>
            <span className="capitalize">{task.mode}</span>
          </>
        )}
        {sessionHref && (
          <>
            <span className="text-border">·</span>
            <Link
              to={sessionHref}
              className="inline-flex items-center gap-1 text-primary hover:underline"
              data-testid="tasks__session-link"
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

interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

interface CodingAgentDef {
  id: string;
  type: string;
  label: string;
  model?: string;
}

function NewTaskDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    workspaceId: string,
    prompt: string,
    mode?: string,
    model?: string,
    codingAgentId?: string,
  ) => Promise<void>;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [selectedMode, setSelectedMode] = useState<string>("");
  const [modes, setModes] = useState<AgentMode[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
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
      setSelectedModel("");
      setSelectedAgent("");
      setSubmitError(null);
      trpc.projects.list.query().then((data) => {
        setProjects(data.projects as ProjectInfo[]);
      });
      trpc.settings.get.query().then((settings) => {
        const raw = (settings as Record<string, unknown>).codingAgents;
        const codingAgents = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
        if (codingAgents.length > 0) {
          const seen = new Set<string>();
          const unique = codingAgents.filter((a) => {
            if (seen.has(a.type)) return false;
            seen.add(a.type);
            return true;
          });
          setAgents(unique);
        } else {
          setAgents([]);
        }
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const agentId = selectedAgent || undefined;
    trpc.modes.list.query({ agentId }).then((data) => {
      const newModes = data.modes as AgentMode[];
      setModes(newModes);
      setSelectedMode((prev) => (newModes.some((m) => m.id === prev) ? prev : ""));
    });
    trpc.models.list
      .query({ agentId })
      .then((data) => {
        const newModels = data.models as ModelInfo[];
        setModels(newModels);
        // Pre-select the agent's configured default model from settings
        const defaultModel = (data.defaultModel as string) ?? "";
        setSelectedModel((prev) =>
          prev && newModels.some((m) => m.id === prev) ? prev : defaultModel,
        );
      })
      .catch(() => setModels([]));
  }, [open, selectedAgent]);

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
      await onSubmit(
        workspaceId,
        prompt.trim(),
        selectedMode || undefined,
        selectedModel || undefined,
        selectedAgent || undefined,
      );
      setSelectedProject("");
      setSelectedBranch("");
      setPrompt("");
      setSelectedMode("");
      setSelectedModel("");
      setSelectedAgent("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to submit task");
    } finally {
      setSubmitting(false);
    }
  }, [workspaceId, prompt, selectedMode, selectedModel, selectedAgent, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="tasks__new-task-dialog">
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
              <SelectTrigger id="project-select" data-testid="tasks__new-task-project">
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
              <SelectTrigger id="branch-select" data-testid="tasks__new-task-workspace">
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

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="task-prompt">
              Prompt
            </label>
            <Textarea
              id="task-prompt"
              data-testid="tasks__new-task-prompt"
              placeholder="Describe what the agent should do..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </div>

          {(agents.length > 1 || models.length > 0 || modes.length > 0) && (
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>svg]:rotate-90">
                <ChevronRight className="size-3.5 transition-transform" />
                Advanced options
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="flex flex-col gap-4 pt-3">
                  {agents.length > 1 && (
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium" htmlFor="agent-select">
                        Agent
                      </label>
                      <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                        <SelectTrigger id="agent-select">
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {models.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium" htmlFor="model-select">
                        Model
                      </label>
                      <Select value={selectedModel} onValueChange={setSelectedModel}>
                        <SelectTrigger id="model-select">
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          {models.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

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
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

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
