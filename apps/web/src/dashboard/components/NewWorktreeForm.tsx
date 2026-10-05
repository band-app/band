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
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useCreateWorkspace } from "../hooks/use-project-mutations";
import { useProjects } from "../hooks/use-projects";

interface Props {
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const LOCAL_HOST_ID = "local";

export function NewWorkspaceDialog({ projectName, open, onOpenChange }: Props) {
  const [chosenHostId, setHostId] = useState(LOCAL_HOST_ID);
  const [hostProjectPath, setHostProjectPath] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [prompt, setPrompt] = useState("");
  const createWorkspaceMutation = useCreateWorkspace();
  const { projects } = useProjects();
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: open,
  });
  // Only machines that are connected can take a new workspace. Local is there unless the hub turned it off.
  const hostChoices = (hosts.data ?? []).filter(
    (h) => h.usable && (h.id === LOCAL_HOST_ID || h.status === "online"),
  );
  // A host that went offline since it was picked falls back to local, or to the first host left.
  const hostId = hostChoices.some((h) => h.id === chosenHostId)
    ? chosenHostId
    : (hostChoices[0]?.id ?? LOCAL_HOST_ID);
  const remote = hostId !== LOCAL_HOST_ID;
  const hostRoots = hostChoices.find((h) => h.id === hostId)?.roots ?? [];

  const slug = slugifyBranchName(branch);

  const slugError: string | null = (() => {
    if (branch && !slug) return "Branch name contains no valid characters.";
    if (slug) {
      const project = projects.find((p) => p.name === projectName);
      if (project?.worktrees.some((wt) => wt.branch === slug)) {
        return `A workspace named "${slug}" already exists.`;
      }
    }
    return null;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug || slugError) return;
    try {
      await createWorkspaceMutation.mutateAsync({
        project: projectName,
        branch: slug,
        base: base.trim() || undefined,
        prompt: prompt.trim() || undefined,
        host: remote ? { hostId, hostProjectPath: hostProjectPath.trim() || undefined } : undefined,
      });
    } catch {
      // The error shows in the dialog, which stays open.
      return;
    }
    setBranch("");
    setBase("");
    setPrompt("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]" data-testid="new-workspace-form__dialog">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Workspace</DialogTitle>
            <DialogDescription>Create a new worktree branch for {projectName}.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            {hostChoices.length > 1 && (
              <>
                <Label htmlFor="workspace-host">Host</Label>
                <select
                  id="workspace-host"
                  data-testid="new-workspace-form__host"
                  value={hostId}
                  onChange={(e) => setHostId(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {hostChoices.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            {remote && (
              <>
                <Label htmlFor="host-project-path">
                  Repository path on {hostChoices.find((h) => h.id === hostId)?.name ?? hostId}
                </Label>
                <Input
                  id="host-project-path"
                  data-testid="new-workspace-form__host-path"
                  placeholder="Needed the first time. Remembered after that."
                  value={hostProjectPath}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setHostProjectPath(e.target.value)
                  }
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {hostRoots.length > 0 && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="new-workspace-form__host-roots"
                  >
                    Must be inside: {hostRoots.join(", ")}. Use an absolute path; ~ means the host's
                    home directory.
                  </p>
                )}
              </>
            )}
            <Label htmlFor="branch-name">Branch name</Label>
            <Input
              id="branch-name"
              placeholder="feature/my-branch"
              value={branch}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
            {branch && slug !== branch && !slugError && (
              <p className="text-xs text-muted-foreground">
                Will be created as: <code>{slug}</code>
              </p>
            )}
            {slugError && <p className="text-xs text-destructive">{slugError}</p>}
            {createWorkspaceMutation.error && (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="new-workspace-form__error"
              >
                {createWorkspaceMutation.error.message}
              </p>
            )}
            <Label htmlFor="base-branch">Base branch (optional)</Label>
            <Input
              id="base-branch"
              placeholder="main"
              value={base}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBase(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Label htmlFor="initial-prompt">Initial prompt (optional)</Label>
            <Textarea
              id="initial-prompt"
              placeholder="Describe the task for the coding agent..."
              value={prompt}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!slug || !!slugError || createWorkspaceMutation.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
