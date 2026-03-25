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
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@band-app/ui";
import { createFileRoute } from "@tanstack/react-router";
import { Clock, Loader2, Pencil, Play, Plus, RefreshCw, Timer, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "../lib/is-tauri";
import { trpc } from "../lib/trpc-client";

export const Route = createFileRoute("/cronjobs")({
  component: CronjobsPage,
});

interface CronjobRecord {
  id: string;
  fileKey: string;
  name: string;
  prompt: string;
  cronExpression: string;
  scope: "project" | "workspace";
  workspaceId?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: "completed" | "failed" | "skipped";
}

interface ProjectInfo {
  name: string;
  defaultBranch: string;
  worktrees: { branch: string; workspaceId?: string }[];
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
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

function CronjobsPage() {
  const [cronjobs, setCronjobs] = useState<CronjobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [showDialog, setShowDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<CronjobRecord | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cronjobsData = await trpc.cronjobs.list.query();
      setCronjobs(cronjobsData.jobs as CronjobRecord[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cronjobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const filteredCronjobs = useMemo(() => {
    if (projectFilter === "all") return cronjobs;
    return cronjobs.filter((job) => {
      if (job.scope === "project") return job.fileKey === projectFilter;
      return job.workspaceId?.startsWith(`${projectFilter}-`);
    });
  }, [cronjobs, projectFilter]);

  const projectNames = useMemo(() => {
    const names = new Set<string>();
    for (const job of cronjobs) {
      if (job.scope === "project") names.add(job.fileKey);
      else if (job.workspaceId) {
        const dash = job.workspaceId.indexOf("-");
        if (dash > 0) names.add(job.workspaceId.slice(0, dash));
      }
    }
    return Array.from(names).sort();
  }, [cronjobs]);

  const handleEdit = useCallback((job: CronjobRecord) => {
    setEditingJob(job);
    setShowDialog(true);
  }, []);

  const handleCreate = useCallback(() => {
    setEditingJob(null);
    setShowDialog(true);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    if (!open) {
      setShowDialog(false);
      setEditingJob(null);
    }
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      {isTauri && (
        <div data-tauri-drag-region className="h-[28px] shrink-0 flex items-center justify-center">
          <span className="text-xs font-medium text-muted-foreground select-none pointer-events-none">
            Cronjobs
          </span>
        </div>
      )}
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Cronjobs</h1>
        </div>
        <Button size="sm" onClick={handleCreate}>
          <Plus className="size-4" />
          New Cronjob
        </Button>
      </header>

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

        <button
          type="button"
          onClick={fetchData}
          className="ml-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {loading && cronjobs.length === 0 && (
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

        {!loading && !error && filteredCronjobs.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Timer className="size-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No cronjobs found</p>
              <p className="text-sm text-muted-foreground">
                {cronjobs.length > 0
                  ? "Try adjusting your filters"
                  : "Create a cronjob to run scheduled agent tasks"}
              </p>
            </div>
          </div>
        )}

        {filteredCronjobs.length > 0 && (
          <div className="flex flex-col gap-2 p-4">
            {filteredCronjobs.map((job) => (
              <CronjobCard key={job.id} job={job} onRefresh={fetchData} onEdit={handleEdit} />
            ))}
          </div>
        )}
      </main>

      <CronjobDialog
        open={showDialog}
        onOpenChange={handleDialogClose}
        editingJob={editingJob}
        onSaved={fetchData}
      />
    </div>
  );
}

function LastRunBadge({ status }: { status?: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="secondary" className="gap-1 text-green-400">
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          Failed
        </Badge>
      );
    case "skipped":
      return (
        <Badge variant="secondary" className="gap-1 text-yellow-400">
          Skipped
        </Badge>
      );
    default:
      return null;
  }
}

function CronjobCard({
  job,
  onRefresh,
  onEdit,
}: {
  job: CronjobRecord;
  onRefresh: () => void;
  onEdit: (job: CronjobRecord) => void;
}) {
  const [acting, setActing] = useState(false);
  const [toggling, setToggling] = useState(false);

  const handleTrigger = useCallback(async () => {
    setActing(true);
    try {
      await trpc.cronjobs.trigger.mutate({ key: job.fileKey, id: job.id });
      onRefresh();
    } catch {
      onRefresh();
    } finally {
      setActing(false);
    }
  }, [job.fileKey, job.id, onRefresh]);

  const handleDelete = useCallback(async () => {
    setActing(true);
    try {
      await trpc.cronjobs.delete.mutate({ key: job.fileKey, id: job.id });
      onRefresh();
    } catch {
      onRefresh();
    } finally {
      setActing(false);
    }
  }, [job.fileKey, job.id, onRefresh]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setToggling(true);
      try {
        await trpc.cronjobs.update.mutate({
          key: job.fileKey,
          id: job.id,
          enabled,
        });
        onRefresh();
      } catch {
        onRefresh();
      } finally {
        setToggling(false);
      }
    },
    [job.fileKey, job.id, onRefresh],
  );

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border border-border/50 bg-card p-4 transition-colors hover:border-border ${
        !job.enabled ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">{job.name}</p>
            <Badge variant="outline" className="text-xs">
              {job.scope}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{job.prompt}</p>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={job.enabled} onCheckedChange={handleToggle} disabled={toggling} />
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-mono">
          <Clock className="size-3" />
          {job.cronExpression}
        </span>
        <span className="text-border">·</span>
        <span className="font-medium text-foreground/70">
          {job.scope === "workspace" ? job.workspaceId : job.fileKey}
        </span>
        {job.lastRunAt && (
          <>
            <span className="text-border">·</span>
            <span>Last run {relativeTime(job.lastRunAt)}</span>
            <LastRunBadge status={job.lastRunStatus} />
          </>
        )}
      </div>

      <div className="flex items-center gap-1 pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={handleTrigger}
          disabled={acting}
        >
          {acting ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          Run Now
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => onEdit(job)}>
          <Pencil className="size-3" />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
          onClick={handleDelete}
          disabled={acting}
        >
          <Trash2 className="size-3" />
          Delete
        </Button>
      </div>
    </div>
  );
}

function CronjobDialog({
  open,
  onOpenChange,
  editingJob,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingJob: CronjobRecord | null;
  onSaved: () => void;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [scope, setScope] = useState<"project" | "workspace">("project");
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset form and fetch projects when dialog opens
  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    trpc.projects.list.query().then((data) => {
      const loadedProjects = data.projects as ProjectInfo[];
      setProjects(loadedProjects);

      if (editingJob) {
        setName(editingJob.name);
        setPrompt(editingJob.prompt);
        setCronExpression(editingJob.cronExpression);
        setScope(editingJob.scope);
        setEnabled(editingJob.enabled);
        if (editingJob.scope === "project") {
          setSelectedProject(editingJob.fileKey);
          setSelectedWorkspaceId("");
        } else {
          setSelectedWorkspaceId(editingJob.workspaceId ?? "");
          const proj = loadedProjects.find((p) =>
            p.worktrees.some((w) => w.workspaceId === editingJob.workspaceId),
          );
          setSelectedProject(proj?.name ?? "");
        }
      } else {
        setName("");
        setPrompt("");
        setCronExpression("");
        setScope("project");
        setSelectedProject("");
        setSelectedWorkspaceId("");
        setEnabled(true);
      }
    });
  }, [open, editingJob]);

  const workspaces = useMemo(() => {
    const project = projects.find((p) => p.name === selectedProject);
    return (
      project?.worktrees.map((w) => ({
        branch: w.branch,
        workspaceId: w.workspaceId ?? `${selectedProject}-${w.branch.replaceAll("/", "-")}`,
      })) ?? []
    );
  }, [projects, selectedProject]);

  const fileKey = useMemo(() => {
    if (scope === "project") return selectedProject;
    return selectedWorkspaceId;
  }, [scope, selectedProject, selectedWorkspaceId]);

  const canSubmit =
    name.trim() &&
    prompt.trim() &&
    cronExpression.trim() &&
    fileKey &&
    (scope === "project" || selectedWorkspaceId);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (editingJob) {
        await trpc.cronjobs.update.mutate({
          key: editingJob.fileKey,
          id: editingJob.id,
          name: name.trim(),
          prompt: prompt.trim(),
          cronExpression: cronExpression.trim(),
          enabled,
        });
      } else {
        await trpc.cronjobs.create.mutate({
          key: fileKey,
          name: name.trim(),
          prompt: prompt.trim(),
          cronExpression: cronExpression.trim(),
          scope,
          workspaceId: scope === "workspace" ? selectedWorkspaceId : undefined,
          enabled,
        });
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save cronjob");
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    editingJob,
    name,
    prompt,
    cronExpression,
    scope,
    fileKey,
    selectedWorkspaceId,
    enabled,
    onOpenChange,
    onSaved,
  ]);

  const handleProjectChange = useCallback((value: string) => {
    setSelectedProject(value);
    setSelectedWorkspaceId("");
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingJob ? "Edit Cronjob" : "New Cronjob"}</DialogTitle>
          <DialogDescription>
            {editingJob ? "Update the cronjob configuration" : "Schedule a recurring agent task"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="cj-name">Name</Label>
            <Input
              id="cj-name"
              placeholder="e.g., Daily dependency check"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="cj-prompt">Prompt</Label>
            <Textarea
              id="cj-prompt"
              placeholder="Describe what the agent should do..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="cj-cron">Cron Expression</Label>
            <Input
              id="cj-cron"
              placeholder="e.g., 0 */6 * * *"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Standard cron format: minute hour day month weekday
            </p>
          </div>

          {!editingJob && (
            <>
              <div className="flex flex-col gap-2">
                <Label>Scope</Label>
                <Select value={scope} onValueChange={(v) => setScope(v as "project" | "workspace")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">Project (main branch)</SelectItem>
                    <SelectItem value="workspace">Workspace (specific branch)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label>Project</Label>
                <Select value={selectedProject} onValueChange={handleProjectChange}>
                  <SelectTrigger>
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

              {scope === "workspace" && (
                <div className="flex flex-col gap-2">
                  <Label>Workspace</Label>
                  <Select
                    value={selectedWorkspaceId}
                    onValueChange={setSelectedWorkspaceId}
                    disabled={!selectedProject}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          selectedProject ? "Select a workspace" : "Select a project first"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaces.map((ws) => (
                        <SelectItem key={ws.workspaceId} value={ws.workspaceId}>
                          {ws.branch}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          <div className="flex items-center gap-3">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="cj-enabled" />
            <Label htmlFor="cj-enabled">Enabled</Label>
          </div>

          {submitError && <p className="text-sm text-destructive">{submitError}</p>}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={handleSubmit} disabled={!canSubmit || submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {editingJob ? "Save Changes" : "Create Cronjob"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
