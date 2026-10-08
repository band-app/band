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
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { crossOriginHub } from "../../lib/hub-config";
import { trpc } from "../../lib/trpc-client";
import { useCapabilities } from "../context";

const LOCAL_HOST_ID = "local";
const OUTSIDE_ROOTS = "OUTSIDE_ROOTS:";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** True when the hub runs on this machine, so a folder picked in the desktop app is on its disk. */
function hubIsOnThisMachine(): boolean {
  let host: string;
  try {
    host = new URL(crossOriginHub()?.origin ?? window.location.origin).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

type Mode = "worker" | "url";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project id the repo is added to. Without one the hub uses the default project. */
  projectId?: string;
  /** The label the new repo gets. */
  label?: string | null;
  /** Opens Settings > Hosts, where a worker is added. Shown in the no-worker notice when set. */
  onOpenHosts?: () => void;
  onAdded?: (repoName: string) => void;
}

/**
 * Adds a repo to the given project (the default project when none is given), either from a folder on a worker (a picker served by that worker) or by
 * its remote URL. A folder outside the worker's roots needs an explicit confirmation first.
 */
export function ProjectAddRepoDialog({
  open,
  onOpenChange,
  projectId,
  label,
  onOpenHosts,
  onAdded,
}: Props) {
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("worker");
  const [chosenHost, setChosenHost] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingPath, setPendingPath] = useState<{ path: string; roots: string } | null>(null);

  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: open,
  });
  const hostChoices = (hosts.data ?? []).filter(
    (h) => h.usable && (h.id === LOCAL_HOST_ID || h.status === "online"),
  );
  const hostId = hostChoices.some((h) => h.id === chosenHost)
    ? (chosenHost as string)
    : (hostChoices[0]?.id ?? null);
  const hostName = hostChoices.find((h) => h.id === hostId)?.name ?? hostId ?? "the host";

  const listing = useQuery({
    queryKey: ["hosts.browse", hostId, browsePath],
    queryFn: () => trpc.hosts.browse.query({ hostId: hostId as string, path: browsePath }),
    enabled: open && mode === "worker" && hostId !== null,
    retry: false,
  });

  const finish = async (name: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
      queryClient.invalidateQueries({ queryKey: ["repos"] }),
      queryClient.invalidateQueries({ queryKey: ["projects.list"] }),
    ]);
    onAdded?.(name);
    setPendingPath(null);
    setRemoteUrl("");
    setDefaultBranch("");
    onOpenChange(false);
  };

  const addFromFolder = async (path: string, addRoot: boolean) => {
    if (!hostId) return;
    setError(null);
    setBusy(true);
    try {
      const repo = await trpc.repos.addFromWorker.mutate({
        hostId,
        path,
        ...(projectId ? { project: projectId } : {}),
        ...(label ? { label } : {}),
        ...(addRoot ? { addRoot: true } : {}),
      });
      await finish(repo.name);
    } catch (err) {
      const message = errorText(err);
      if (message.startsWith(OUTSIDE_ROOTS)) {
        setPendingPath({ path, roots: message.slice(OUTSIDE_ROOTS.length).trim() });
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const addByUrl = async () => {
    setError(null);
    setBusy(true);
    try {
      const repo = await trpc.repos.addByUrl.mutate({
        remoteUrl: remoteUrl.trim(),
        defaultBranch: defaultBranch.trim() || undefined,
        ...(projectId ? { project: projectId } : {}),
        ...(label ? { label } : {}),
      });
      await finish(repo.name);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const data = listing.data;
  // The native sheet browses this machine's disk, so it only helps when the chosen worker is the
  // hub's own local host and the hub is on this machine.
  const canPickNatively =
    capabilities.pickFolder !== undefined && hostId === LOCAL_HOST_ID && hubIsOnThisMachine();
  const pickNatively = async () => {
    const selected = await capabilities.pickFolder?.();
    if (selected) await addFromFolder(selected, false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" data-testid="project-add-repo__dialog">
        <DialogHeader>
          <DialogTitle>Add repo</DialogTitle>
          <DialogDescription>
            A repo is its remote URL and default branch. Each worker keeps its own folder for it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2" role="tablist" aria-label="How to add the repo">
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "worker"}
            variant={mode === "worker" ? "default" : "outline"}
            data-testid="project-add-repo__mode-worker"
            onClick={() => setMode("worker")}
          >
            From a worker
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "url"}
            variant={mode === "url" ? "default" : "outline"}
            data-testid="project-add-repo__mode-url"
            onClick={() => setMode("url")}
          >
            By URL
          </Button>
        </div>

        {pendingPath ? (
          <div
            className="space-y-2 rounded-md border p-3"
            data-testid="project-add-repo__confirm-root"
          >
            <p className="text-sm">
              This folder is outside the directories {hostName} serves. Add it as a root?
            </p>
            <p className="break-all text-xs text-muted-foreground">{pendingPath.path}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                data-testid="project-add-repo__confirm-root-accept"
                onClick={() => addFromFolder(pendingPath.path, true)}
              >
                Add as a root
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="project-add-repo__confirm-root-cancel"
                onClick={() => setPendingPath(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : mode === "worker" ? (
          <div className="space-y-2">
            {hostChoices.length === 0 ? (
              <div className="space-y-2" data-testid="project-add-repo__no-hosts">
                <p className="text-sm text-muted-foreground">
                  No worker is online. Add one in Settings &gt; Hosts &gt; Add worker, or add the
                  repo by URL.
                </p>
                <div className="flex gap-2">
                  {onOpenHosts ? (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="project-add-repo__open-hosts"
                      onClick={onOpenHosts}
                    >
                      Open Settings &gt; Hosts
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="project-add-repo__no-hosts-url"
                    onClick={() => setMode("url")}
                  >
                    Add by URL
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Label htmlFor="add-repo-host">Worker</Label>
                <select
                  id="add-repo-host"
                  data-testid="project-add-repo__host"
                  value={hostId ?? ""}
                  onChange={(e) => {
                    setChosenHost(e.target.value);
                    setBrowsePath(undefined);
                  }}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {hostChoices.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
                {canPickNatively ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="project-add-repo__pick-native"
                    onClick={pickNatively}
                  >
                    Choose folder on this computer
                  </Button>
                ) : null}
                {listing.error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {errorText(listing.error)}
                  </p>
                ) : null}
                {data ? (
                  <div className="space-y-1" data-testid="project-add-repo__picker">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="break-all text-xs text-muted-foreground"
                        data-testid="project-add-repo__picker-path"
                      >
                        {data.path}
                      </span>
                      <div className="flex gap-1">
                        {data.parent ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid="project-add-repo__picker-up"
                            onClick={() => setBrowsePath(data.parent ?? undefined)}
                          >
                            Up
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          disabled={busy}
                          data-testid="project-add-repo__picker-select"
                          onClick={() => addFromFolder(data.path, false)}
                        >
                          Use this folder
                        </Button>
                      </div>
                    </div>
                    <ul className="max-h-56 overflow-auto rounded-md border">
                      {data.entries.length === 0 ? (
                        <li className="px-2 py-1 text-xs text-muted-foreground">No folders.</li>
                      ) : null}
                      {data.entries.map((entry) => (
                        <li key={entry.path}>
                          <button
                            type="button"
                            data-testid="project-add-repo__picker-entry"
                            data-name={entry.name}
                            data-git={entry.isGit ? "true" : "false"}
                            onClick={() => setBrowsePath(entry.path)}
                            className="flex w-full items-center justify-between px-2 py-1 text-left text-sm hover:bg-muted"
                          >
                            <span>{entry.name}</span>
                            {entry.isGit ? (
                              <span className="text-xs text-muted-foreground">git</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="add-repo-url">Remote URL</Label>
            <Input
              id="add-repo-url"
              data-testid="project-add-repo__url"
              placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Label htmlFor="add-repo-branch">Default branch</Label>
            <Input
              id="add-repo-branch"
              data-testid="project-add-repo__branch"
              placeholder="Optional. The hub asks the remote when empty."
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <DialogFooter>
              <Button
                disabled={busy || remoteUrl.trim() === ""}
                data-testid="project-add-repo__url-submit"
                onClick={addByUrl}
              >
                Add repo
              </Button>
            </DialogFooter>
          </div>
        )}
        {error ? (
          <p
            role="alert"
            data-testid="project-add-repo__error"
            className="text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
