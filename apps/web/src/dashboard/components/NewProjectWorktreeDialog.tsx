import { slugifyBranchName } from "@band-app/shared/branch-name";
import { toWorktreeId } from "@band-app/shared/worktree-id";
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

export interface NewWorktreeProject {
  id: string;
  name: string;
  repos: Array<{ repo: string; role: string | null }>;
}

/**
 * "New worktree" in a project: one repo of the project, a branch and an optional first message for
 * its agent. Calls `worktrees.create` with the project, so the worktree is listed under it. Work in
 * several repos takes one worktree per repo.
 */
export function NewProjectWorktreeDialog({
  project,
  open,
  onOpenChange,
  onCreated,
}: {
  project: NewWorktreeProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (worktreeId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [prompt, setPrompt] = useState("");
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

  const chosenRepo = repo || project.repos[0]?.repo || "";
  const branchValue = slugifyBranchName(branch) ?? "";
  const ready = chosenRepo !== "" && branchValue !== "";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.worktrees.create.mutate({
        repo: chosenRepo,
        branch: branchValue,
        projectId: project.id,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(hostId !== DEFAULT_PLACEMENT ? { hostId } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["projects.list"] });
      setBranch("");
      setPrompt("");
      setHostId(DEFAULT_PLACEMENT);
      onOpenChange(false);
      onCreated(toWorktreeId(chosenRepo, branchValue));
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
        data-testid="new-project-worktree"
        data-project={project.name}
      >
        <DialogHeader>
          <DialogTitle>New worktree in {project.name}</DialogTitle>
          <DialogDescription>
            A worktree of one repo of the project, on a new branch. Work in several repos takes one
            worktree per repo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="new-project-worktree-repo">Repo</Label>
            {project.repos.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                This project has no repos yet. Add one from its Repos tab.
              </p>
            ) : (
              <select
                id="new-project-worktree-repo"
                data-testid="new-project-worktree__repo"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={chosenRepo}
                onChange={(e) => setRepo(e.target.value)}
              >
                {project.repos.map((r) => (
                  <option key={r.repo} value={r.repo}>
                    {r.repo}
                    {r.role ? ` (${r.role})` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-project-worktree-branch">Branch</Label>
            <Input
              id="new-project-worktree-branch"
              data-testid="new-project-worktree__branch"
              value={branch}
              placeholder="feat/checkout-flow"
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-project-worktree-prompt">
              First message to the agent (optional)
            </Label>
            <Textarea
              id="new-project-worktree-prompt"
              data-testid="new-project-worktree__prompt"
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-project-worktree-host">Host</Label>
            <select
              id="new-project-worktree-host"
              data-testid="new-project-worktree__host"
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
            <p
              role="alert"
              data-testid="new-project-worktree__error"
              className="text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="new-project-worktree__submit"
            disabled={!ready || busy}
            onClick={submit}
          >
            Create worktree
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
