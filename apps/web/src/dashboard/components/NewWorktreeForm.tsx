import { slugifyBranchName } from "@band-app/shared/branch-name";
import { isHostAllowed } from "@band-app/shared/repo-hosts";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CircleAlert } from "lucide-react";
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
  const [moreOpen, setMoreOpen] = useState(false);
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

  const hostLabel = hostChoices.find((h) => h.id === hostId)?.name ?? hostId;
  const folderRequired = remote && !repoInfo?.remoteUrl;
  const showFolder = remote;
  const folderField = (
    <div className="grid gap-1.5">
      <Label htmlFor="host-repo-path">
        {folderRequired ? `Repository folder on ${hostLabel}` : `Folder on ${hostLabel}`}
      </Label>
      <Input
        id="host-repo-path"
        data-testid="new-worktree-form__host-path"
        value={hostRepoPath}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHostRepoPath(e.target.value)}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
  const branchInvalid = !!slugError;
  const serverError = createWorktreeMutation.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="new-worktree-form__dialog">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New worktree in {repoName}</DialogTitle>
            <DialogDescription className="sr-only">
              Choose a branch name and an optional prompt for the coding agent.
            </DialogDescription>
          </DialogHeader>
          <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 py-4">
              <div className="grid gap-1.5">
                <Label htmlFor="branch-name">Branch</Label>
                <div className="relative">
                  <Input
                    id="branch-name"
                  data-testid="new-worktree-form__branch"
                    placeholder="feat/my-branch"
                    value={branch}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    aria-invalid={branchInvalid || undefined}
                    className={branchInvalid ? "border-destructive pr-9" : undefined}
                  />
                  {slugError && (
                    <ErrorHint
                      testId="new-worktree-form__slug-error"
                      label="Branch error"
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                    >
                      <p data-testid="new-worktree-form__slug-error-message">{slugError}</p>
                      {existingId && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          data-testid="new-worktree-form__open-existing"
                          onClick={() => {
                            openWorktree(existingId);
                            onOpenChange(false);
                          }}
                        >
                          Open it
                        </Button>
                      )}
                    </ErrorHint>
                  )}
                </div>
                {branch && slug && slug !== branch && !slugError && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="new-worktree-form__slug"
                  >
                    Creates <code>{slug}</code>
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="initial-prompt">Prompt</Label>
                <Textarea
                  id="initial-prompt"
                  placeholder="What should the agent do? Leave empty to start without a task."
                  value={prompt}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setPrompt(e.target.value)
                  }
                  rows={3}
                />
              </div>
              {folderRequired && folderField}
              <CollapsibleContent className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="base-branch">Base branch</Label>
                  <Input
                    id="base-branch"
                    data-testid="new-worktree-form__base"
                    placeholder={repoInfo?.defaultBranch ?? "main"}
                    value={base}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBase(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                {showFolder && !folderRequired && folderField}
              </CollapsibleContent>
            </div>
            <DialogFooter className="items-center">
              <div className="flex w-full min-w-0 items-center gap-2 sm:mr-auto sm:flex-1">
                {hostChoices.length > 1 && (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Label htmlFor="worktree-host">Worker</Label>
                    <select
                      id="worktree-host"
                      data-testid="new-worktree-form__host"
                      value={hostId}
                      onChange={(e) => setHostId(e.target.value)}
                      className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm"
                    >
                      {hostChoices.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1 text-muted-foreground"
                    data-testid="new-worktree-form__more-options"
                  >
                    <ChevronRight
                      className={`size-4 transition-transform ${moreOpen ? "rotate-90" : ""}`}
                    />
                    More options
                  </Button>
                </CollapsibleTrigger>
              </div>

              {serverError && (
                <ErrorHint testId="new-worktree-form__error" label="Create error">
                  <p data-testid="new-worktree-form__error-message">{serverError.message}</p>
                </ErrorHint>
              )}
              <p role="alert" className="sr-only">
                {serverError?.message}
||||||| e5fed232
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
          </Collapsible>
||||||| e5fed232
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
              disabled={!slug || !!slugError || createWorktreeMutation.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
  </DialogContent>
    </Dialog>
  )
}

/** An error icon that opens a popover with the message, so no error text sits inline. */
function ErrorHint({
  testId,
  label,
  className,
  children,
}: {
  testId: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className={`rounded-sm p-1 text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring ${className ?? ""}`}
        >
          <CircleAlert className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="text-sm" aria-live="polite">
        {children}
      </PopoverContent>
    </Popover>
  );
}
