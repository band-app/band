import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Spinner,
} from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useCapabilities } from "../context";
import { useHostList } from "../hooks/use-host-status";
import { useRepos } from "../hooks/use-repos";
import { useWorktreeDisplay } from "../hooks/use-worktree-display";
import type { WorktreeInfo } from "../types";
import { useIsAdmin } from "./settings/DevicesSettings";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type MoveResult = Awaited<ReturnType<typeof trpc.checkpoints.move.mutate>>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoName: string;
  worktree: Pick<WorktreeInfo, "name" | "hostId">;
  /** The host to select when the dialog opens, from a drop on that host's group. */
  initialTarget?: string;
}

/**
 * Moves a worktree whose host is online to another host ("Open on another host"). A host the repo
 * is not allowed on is offered with "add it to the allowed hosts", which needs an admin token. An
 * offline host goes through `ContinueOnHostDialog` instead.
 */
export function MoveWorktreeDialog({
  open,
  onOpenChange,
  repoName,
  worktree,
  initialTarget,
}: Props) {
  const { repos } = useRepos();
  const displayWorktree = useWorktreeDisplay();
  const repo = {
    name: repoName,
    allowedHostIds: repos.find((r) => r.name === repoName)?.allowedHostIds,
  };
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const admin = useIsAdmin();
  const hosts = useHostList();
  const currentHost = worktree.hostId ?? "local";
  const worktreeId = toWorktreeId(repo.name, worktree.name, worktree.hostId);
  const targets = hosts.filter(
    (h) => h.status === "online" && h.id !== currentHost && h.id !== "local",
  );

  const [target, setTarget] = useState(initialTarget ?? "");
  const [addHost, setAddHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerAdd, setOfferAdd] = useState(false);
  const [result, setResult] = useState<MoveResult | null>(null);

  const chosen = target || targets[0]?.id || "";
  const allowed = repo.allowedHostIds ?? null;
  const notAllowed = chosen !== "" && allowed !== null && !allowed.includes(chosen);
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name || id;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = { worktreeId, toHostId: chosen, ...(addHost ? { addHost: true } : {}) };
      setResult(await trpc.checkpoints.move.mutate(input));
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
      const code = (err as { data?: { code?: string } }).data?.code;
      if (code === "PRECONDITION_FAILED" && notAllowed) setOfferAdd(true);
    } finally {
      setBusy(false);
    }
  };

  const openNew = () => {
    if (!result) return;
    const href = capabilities.getWorktreeHref?.(result.worktreeId);
    if (href && capabilities.navigate) capabilities.navigate(href);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid="move-worktree__dialog">
        <DialogHeader>
          <DialogTitle>Open on another worker</DialogTitle>
          <DialogDescription>
            Takes a fresh checkpoint of {worktree.name}, recreates it on the chosen host with its
            uncommitted files and agent sessions, then removes the copy on {hostName(currentHost)}.
          </DialogDescription>
          <p className="text-xs text-muted-foreground" data-testid="move-worktree__ignored-files">
            Ignored files (node_modules, build output, .env) are not carried over.
          </p>
        </DialogHeader>
        {result ? (
          <div className="space-y-2" data-testid="move-worktree__result">
            <p className="text-sm">
              Moved to {hostName(result.hostId)} as{" "}
              <span className="font-mono">{displayWorktree(result.worktreeId).name}</span>.
            </p>
            {result.warning ? (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="move-worktree__warning"
              >
                {result.warning}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button size="sm" data-testid="move-worktree__open" onClick={openNew}>
                Open worktree
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {targets.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="move-worktree__no-hosts">
                No other worker is online.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="move-worktree-host">Target worker</Label>
                <select
                  id="move-worktree-host"
                  data-testid="move-worktree__host"
                  className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm"
                  value={chosen}
                  disabled={busy}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setAddHost(false);
                    setOfferAdd(false);
                    setError(null);
                  }}
                >
                  {targets.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name || h.id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {notAllowed || offerAdd ? (
              <div className="space-y-1" data-testid="move-worktree__add-host">
                <p className="text-xs text-muted-foreground">
                  {repo.name} is not allowed on {hostName(chosen)}.
                </p>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={addHost}
                    disabled={!admin || busy}
                    data-testid="move-worktree__add-host-checkbox"
                    onChange={(e) => setAddHost(e.target.checked)}
                  />
                  Add {hostName(chosen)} to {repo.name}'s allowed hosts
                </label>
                {admin ? null : (
                  <p className="text-xs text-muted-foreground">
                    Adding a worker needs an admin token.
                  </p>
                )}
              </div>
            ) : null}
            {error ? (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="move-worktree__error"
              >
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid="move-worktree__submit"
                disabled={busy || chosen === "" || (notAllowed && !addHost)}
                onClick={() => void run()}
              >
                {busy ? <Spinner className="size-3" /> : null}
                Open on another worker
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
