import { slugifyBranchName } from "@band-app/shared/branch-name";
import { isHostAllowed } from "@band-app/shared/repo-hosts";
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
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useGroupFilter } from "../hooks/use-group-filter";
import { useGroups } from "../hooks/use-groups";
import { useHostNames } from "../hooks/use-host-names";
import { useCreateWorktree } from "../hooks/use-repo-mutations";
import { useRepos } from "../hooks/use-repos";
import { useDashboardStore } from "../stores/index";

interface Props {
  repoName: string;
  /**
   * The group the worktree joins (null for none). Without it the sidebar's group filter decides,
   * and with no filter the worktree joins its origin's group.
   */
  groupId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const LOCAL_HOST_ID = "local";

/** The worktree the hub names when it refuses a branch that is already on another host. */
function conflictedWorktreeId(error: unknown): string | undefined {
  const id = (error as { data?: { existingWorktreeId?: unknown } } | null)?.data
    ?.existingWorktreeId;
  return typeof id === "string" ? id : undefined;
}

export function NewWorktreeDialog({
  repoName,
  groupId: explicitGroupId,
  open,
  onOpenChange,
}: Props) {
  const [chosenHostId, setHostId] = useState(LOCAL_HOST_ID);
  const [hostRepoPath, setHostRepoPath] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [prompt, setPrompt] = useState("");
  const createWorktreeMutation = useCreateWorktree();
  const { repos } = useRepos();
  // A worktree made while the sidebar is filtered to a group joins that group.
  const [groupFilter] = useGroupFilter();
  const groups = useGroups();
  const filteredGroupId =
    groupFilter && groups.some((g) => g.id === groupFilter) ? groupFilter : undefined;
  const groupId = explicitGroupId !== undefined ? explicitGroupId : filteredGroupId;
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.workers.list.query()).hosts,
    enabled: open,
  });
  const hostName = useHostNames();
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const repoInfo = repos.find((p) => p.name === repoName);
  // Only machines that are connected can take a new worktree, and only those the repo may run on.
  // Local is there unless the hub turned it off.
  const hostChoices = (hosts.data ?? []).filter(
    (h) =>
      h.usable &&
      (h.id === LOCAL_HOST_ID || h.status === "online") &&
      isHostAllowed(repoInfo?.allowedHostIds, h.id),
  );
  // A host that went offline since it was picked falls back to local, or to the first host left.
  const hostId = hostChoices.some((h) => h.id === chosenHostId)
    ? chosenHostId
    : (hostChoices[0]?.id ?? LOCAL_HOST_ID);
  const remote = hostId !== LOCAL_HOST_ID;
  const hostRoots = hostChoices.find((h) => h.id === hostId)?.roots ?? [];

  const slug = slugifyBranchName(branch);

  // A branch lives on one host only: the same name on another host is that worktree, to open.
  const onOtherHost = slug
    ? repoInfo?.worktrees.find(
        (wt) => (wt.name === slug || wt.branch === slug) && (wt.hostId || LOCAL_HOST_ID) !== hostId,
      )
    : undefined;
  const existingId = onOtherHost
    ? toWorktreeId(repoName, onOtherHost.name, onOtherHost.hostId)
    : (conflictedWorktreeId(createWorktreeMutation.error) ?? null);

  const slugError: string | null = (() => {
    if (branch && !slug) return "Branch name contains no valid characters.";
    if (onOtherHost) return `${slug} is already on ${hostName(onOtherHost.hostId)}`;
    if (slug) {
      if (repoInfo?.worktrees.some((wt) => wt.branch === slug)) {
        return `A worktree named "${slug}" already exists.`;
      }
    }
    return null;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug || slugError) return;
    try {
      await createWorktreeMutation.mutateAsync({
        repo: repoName,
        branch: slug,
        base: base.trim() || undefined,
        prompt: prompt.trim() || undefined,
        host: remote ? { hostId, hostRepoPath: hostRepoPath.trim() || undefined } : undefined,
        groupId,
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
      <DialogContent className="sm:max-w-[425px]" data-testid="new-worktree-form__dialog">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Worktree</DialogTitle>
            <DialogDescription>Create a new worktree branch for {repoName}.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 py-4">
            {hostChoices.length > 1 && (
              <>
                <Label htmlFor="worktree-host">Worker</Label>
                <select
                  id="worktree-host"
                  data-testid="new-worktree-form__host"
                  value={hostId}
                  onChange={(e) => setHostId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
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
                <Label htmlFor="host-repo-path">
                  {repoInfo?.remoteUrl ? "Use another folder on " : "Repository path on "}
                  {hostChoices.find((h) => h.id === hostId)?.name ?? hostId}
                  {repoInfo?.remoteUrl ? " (optional)" : ""}
                </Label>
                <Input
                  id="host-repo-path"
                  data-testid="new-worktree-form__host-path"
                  placeholder={
                    repoInfo?.remoteUrl
                      ? "Optional. The worker uses its folder for this repo or clones it."
                      : "Needed the first time. Remembered after that."
                  }
                  value={hostRepoPath}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setHostRepoPath(e.target.value)
                  }
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {hostRoots.length > 0 && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="new-worktree-form__host-roots"
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
              data-testid="new-worktree-form__branch"
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
            {slugError && (
              <p className="text-xs text-destructive" data-testid="new-worktree-form__slug-error">
                {slugError}
              </p>
            )}
            {createWorktreeMutation.error && (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="new-worktree-form__error"
              >
                {createWorktreeMutation.error.message}
              </p>
            )}
            {existingId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="new-worktree-form__open-existing"
                onClick={() => {
                  openWorktree(existingId);
                  onOpenChange(false);
                }}
              >
                Open it
              </Button>
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
              data-testid="new-worktree-form__submit"
              disabled={!slug || !!slugError || createWorktreeMutation.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
