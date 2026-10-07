import { slugifyBranchName } from "@band-app/shared/branch-name";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";

const LOCAL_HOST_ID = "local";
const DEFAULT_PLACEMENT = "";
const TASK_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export interface NewTaskProject {
  id: string;
  name: string;
  repos: Array<{ repo: string; role: string | null }>;
}

/**
 * "New task" in a project: a name, the branch (derived from the name until edited), the member
 * repos as checkboxes (none is allowed, the agent then adds repos itself), a markdown brief and a
 * host. Calls `projectTasks.create`, which makes the task folder, its worktrees and its chat.
 */
export function NewTaskDialog({
  project,
  open,
  onOpenChange,
  onCreated,
}: {
  project: NewTaskProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: { id: string; name: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [brief, setBrief] = useState("");
  const [hostId, setHostId] = useState(DEFAULT_PLACEMENT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: open,
  });
  const hostChoices = (hosts.data ?? []).filter(
    (h) => h.usable && (h.id === LOCAL_HOST_ID || h.status === "online"),
  );

  const branchValue = branch ?? slugifyBranchName(name) ?? "";
  const taskName = name.trim();
  const ready = taskName !== "" && branchValue !== "";

  const toggle = (repo: string) =>
    setPicked((cur) => (cur.includes(repo) ? cur.filter((r) => r !== repo) : [...cur, repo]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await trpc.projectTasks.create.mutate({
        project: project.id,
        branch: branchValue,
        ...(TASK_NAME.test(taskName) ? { name: taskName } : {}),
        title: taskName,
        brief,
        repos: project.repos
          .filter((r) => picked.includes(r.repo))
          .map((r) => ({ repo: r.repo, role: r.role })),
        ...(hostId !== DEFAULT_PLACEMENT ? { hostId } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["projectTasks.list"] });
      setName("");
      setBranch(null);
      setPicked([]);
      setBrief("");
      setHostId(DEFAULT_PLACEMENT);
      onOpenChange(false);
      // With no host that fits, a runner is asked for a machine and the task appears when it connects.
      if ("task" in created) onCreated({ id: created.task.id, name: created.task.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        data-testid="new-task"
        data-project={project.name}
      >
        <DialogHeader>
          <DialogTitle>New task in {project.name}</DialogTitle>
          <DialogDescription>
            A task is a folder with a brief and one worktree per repo you pick, plus a chat.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="new-task-name">Name</Label>
            <Input
              id="new-task-name"
              data-testid="new-task__name"
              value={name}
              placeholder="checkout-flow"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-task-branch">Branch</Label>
            <Input
              id="new-task-branch"
              data-testid="new-task__branch"
              value={branchValue}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Repos</legend>
            {project.repos.length === 0 ? (
              <p className="text-xs text-muted-foreground">This project has no repos yet.</p>
            ) : (
              project.repos.map((r) => (
                <label key={r.repo} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="new-task__repo-option"
                    data-repo={r.repo}
                    checked={picked.includes(r.repo)}
                    onChange={() => toggle(r.repo)}
                  />
                  {r.repo}
                  {r.role ? <span className="text-xs text-muted-foreground">{r.role}</span> : null}
                </label>
              ))
            )}
            <p className="text-xs text-muted-foreground">
              Pick none to start with an empty folder. The agent adds repos from the brief.
            </p>
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="new-task-brief">Brief (markdown)</Label>
            <Textarea
              id="new-task-brief"
              data-testid="new-task__brief"
              rows={6}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-task-host">Host</Label>
            <select
              id="new-task-host"
              data-testid="new-task__host"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
            >
              <option value={DEFAULT_PLACEMENT}>Default placement</option>
              {hostChoices.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.id}
                </option>
              ))}
            </select>
          </div>
          {error ? (
            <p role="alert" data-testid="new-task__error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="new-task__submit" disabled={!ready || busy} onClick={submit}>
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
