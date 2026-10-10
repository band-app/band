import { stripUrlCredentials } from "@band-app/shared/remote-url";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderGit2, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

/** The folders on the way from `/` to `path`, for the picker's breadcrumbs. */
function crumbsOf(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ name: "/", path: "/" }];
  let at = "";
  for (const part of parts) {
    at = `${at}/${part}`;
    crumbs.push({ name: part, path: at });
  }
  return crumbs;
}

type Mode = "worker" | "url";

export interface AddRepoFormProps {
  /** The label the new repo gets: the sidebar's label filter, so the repo stays in view. */
  label?: string | null;
  /** Opens Settings > Hosts, where a worker is added. Shown in the no-worker notice when set. */
  onOpenHosts?: () => void;
  onAdded?: (repoName: string) => void;
  /** Whether the form is on screen, so its queries stop when it is not. */
  active?: boolean;
}

/**
 * Adds a repo, either from a folder on a worker (a picker served by that worker, then a preview of
 * the remote and default branch the worker reads) or by its remote URL (with the default branch the
 * hub resolves). A folder outside the worker's roots needs an explicit confirmation in the preview.
 */
export function AddRepoForm({ label, onOpenHosts, onAdded, active = true }: AddRepoFormProps) {
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("worker");
  const [chosenHost, setChosenHost] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [lookupUrl, setLookupUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outsideRoots, setOutsideRoots] = useState<string | null>(null);
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: active,
  });
  const hostChoices = (hosts.data ?? []).filter(
    (h) => h.usable && (h.id === LOCAL_HOST_ID || h.status === "online"),
  );
  const hostId = hostChoices.some((h) => h.id === chosenHost)
    ? (chosenHost as string)
    : (hostChoices[0]?.id ?? null);
  const hostName = hostChoices.find((h) => h.id === hostId)?.name ?? hostId ?? "the worker";

  const listing = useQuery({
    queryKey: ["hosts.browse", hostId, browsePath],
    queryFn: () => trpc.hosts.browse.query({ hostId: hostId as string, path: browsePath }),
    enabled: active && mode === "worker" && hostId !== null && selected === null,
    retry: false,
  });

  const preview = useQuery({
    queryKey: ["repos.inspectFolder", hostId, selected],
    queryFn: () =>
      trpc.repos.inspectFolder.query({ hostId: hostId as string, path: selected as string }),
    enabled: active && hostId !== null && selected !== null,
    retry: false,
  });

  // Ask the hub for the remote's default branch once the URL stops changing. The query goes out as
  // a GET, so a token pasted in the URL is dropped first rather than reaching a proxy's access log.
  useEffect(() => {
    const id = setTimeout(() => setLookupUrl(remoteUrl.trim()), 400);
    return () => clearTimeout(id);
  }, [remoteUrl]);
  const resolved = useQuery({
    queryKey: ["repos.resolveRemote", lookupUrl],
    queryFn: () => trpc.repos.resolveRemote.query({ remoteUrl: stripUrlCredentials(lookupUrl) }),
    enabled: active && mode === "url" && lookupUrl !== "",
    retry: false,
  });

  const entries = useMemo(() => {
    const all = listing.data?.entries ?? [];
    const needle = filter.trim().toLowerCase();
    return needle ? all.filter((e) => e.name.toLowerCase().includes(needle)) : all;
  }, [listing.data, filter]);

  const browse = (path: string | undefined) => {
    setBrowsePath(path);
    setFilter("");
  };

  const finish = async (name: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["repos.list"] }),
      queryClient.invalidateQueries({ queryKey: ["repos"] }),
    ]);
    setSelected(null);
    setOutsideRoots(null);
    setRemoteUrl("");
    setDefaultBranch("");
    onAdded?.(name);
  };

  const addFromFolder = async (path: string, addRoot: boolean) => {
    if (!hostId) return;
    setError(null);
    setBusy(true);
    try {
      const repo = await trpc.repos.addFromWorker.mutate({
        hostId,
        path,
        ...(label ? { label } : {}),
        ...(addRoot ? { addRoot: true } : {}),
      });
      await finish(repo.name);
    } catch (err) {
      const message = errorText(err);
      if (message.startsWith(OUTSIDE_ROOTS)) {
        setSelected(path);
        setOutsideRoots(message.slice(OUTSIDE_ROOTS.length).trim());
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
        ...(label ? { label } : {}),
      });
      await finish(repo.name);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // The native sheet browses this machine's disk, so it only helps when the chosen worker is the
  // hub's own local host and the hub is on this machine.
  const canPickNatively =
    capabilities.pickFolder !== undefined && hostId === LOCAL_HOST_ID && hubIsOnThisMachine();
  const pickNatively = async () => {
    const picked = await capabilities.pickFolder?.();
    if (picked) setSelected(picked);
  };

  const data = listing.data;
  const info = preview.data;
  // The worker's own refusal wins over the preview's reading of its roots.
  const needsRoot = outsideRoots !== null || (info ? !info.insideRoots : false);
  const uncloneable = info?.cloneable === false;

  return (
    <div className="space-y-4" data-testid="add-repo__form">
      <div className="flex gap-2" role="tablist" aria-label="How to add the repo">
        {(
          [
            ["worker", "From a worker"],
            ["url", "By URL"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            role="tab"
            aria-selected={mode === value}
            variant={mode === value ? "default" : "outline"}
            data-testid={`add-repo__mode-${value}`}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      {mode === "worker" ? (
        hosts.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Looking for workers
          </div>
        ) : hostChoices.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-8 text-center"
            data-testid="add-repo__no-hosts"
          >
            <Server className="size-6 text-muted-foreground" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-medium">No worker is online</p>
              <p className="text-sm text-muted-foreground">
                A worker serves the folders you can add. Add one in Settings &gt; Hosts, or add the
                repo by its URL.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {onOpenHosts ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="add-repo__open-hosts"
                  onClick={onOpenHosts}
                >
                  Add a worker
                </Button>
              ) : null}
              <Button size="sm" data-testid="add-repo__no-hosts-url" onClick={() => setMode("url")}>
                Add by URL
              </Button>
            </div>
          </div>
        ) : selected !== null ? (
          <div className="space-y-3" data-testid="add-repo__preview">
            <p className="break-all font-mono text-xs text-muted-foreground">
              {hostName}: {selected}
            </p>
            {preview.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" /> Reading the folder
              </div>
            ) : preview.error ? (
              <p role="alert" className="text-sm text-destructive">
                {errorText(preview.error)}
              </p>
            ) : info ? (
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 rounded-lg border p-3 text-sm">
                <dt className="text-muted-foreground">Repo name</dt>
                <dd data-testid="add-repo__preview-name">{info.existingRepo ?? info.name}</dd>
                <dt className="text-muted-foreground">Remote URL</dt>
                <dd className="break-all" data-testid="add-repo__preview-url">
                  {info.remoteUrl ?? "None"}
                </dd>
                <dt className="text-muted-foreground">Default branch</dt>
                <dd data-testid="add-repo__preview-branch">{info.defaultBranch ?? "Unknown"}</dd>
              </dl>
            ) : null}
            {info && !info.isGit ? (
              <p className="text-sm text-muted-foreground" data-testid="add-repo__preview-plain">
                This folder is not a git repository. It is added as a plain folder that lives on{" "}
                {hostName} only.
              </p>
            ) : uncloneable ? (
              <p
                role="alert"
                className="text-sm text-destructive"
                data-testid="add-repo__preview-uncloneable"
              >
                The origin URL of this folder is not one Band can clone, so it cannot be added. Fix
                the folder's origin remote and try again.
              </p>
            ) : info && !info.remoteUrl ? (
              <p
                className="rounded-md bg-muted px-3 py-2 text-sm"
                data-testid="add-repo__preview-local-only"
              >
                This repo has no remote, so it stays on {hostName} only. Its worktrees can run only
                there, and other workers cannot clone it.
              </p>
            ) : null}
            {info?.existingRepo ? (
              <p className="text-sm text-muted-foreground" data-testid="add-repo__preview-existing">
                Band already has the repo {info.existingRepo} with this remote. This folder becomes
                its clone on {hostName}.
              </p>
            ) : null}
            {needsRoot ? (
              <div
                className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                data-testid="add-repo__confirm-root"
              >
                <p>
                  This folder is outside the directories {hostName} serves. Adding the repo also
                  adds the folder as a root, so agents on {hostName} can use it.
                </p>
                {(info?.roots.length ?? 0) > 0 || outsideRoots ? (
                  <p className="break-all text-xs text-muted-foreground">
                    Current roots: {outsideRoots ?? info?.roots.join(", ")}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="add-repo__preview-back"
                onClick={() => {
                  setSelected(null);
                  setOutsideRoots(null);
                  setError(null);
                }}
              >
                Back to folders
              </Button>
              <Button
                size="sm"
                disabled={busy || preview.isLoading || preview.isError || uncloneable}
                data-testid={needsRoot ? "add-repo__confirm-root-accept" : "add-repo__confirm"}
                onClick={() => addFromFolder(selected, needsRoot)}
              >
                {busy ? <Spinner className="size-4" /> : null}
                {needsRoot ? "Add root and repo" : "Add repo"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="add-repo-host">Worker</Label>
                <select
                  id="add-repo-host"
                  data-testid="add-repo__host"
                  value={hostId ?? ""}
                  onChange={(e) => {
                    setChosenHost(e.target.value);
                    browse(undefined);
                  }}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {hostChoices.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </div>
              {canPickNatively ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  data-testid="add-repo__pick-native"
                  onClick={pickNatively}
                >
                  Choose on this computer
                </Button>
              ) : null}
            </div>
            {listing.error ? (
              <p role="alert" className="text-sm text-destructive">
                {errorText(listing.error)}
              </p>
            ) : null}
            {listing.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" /> Listing folders
              </div>
            ) : null}
            {data ? (
              <div className="space-y-2" data-testid="add-repo__picker">
                <nav
                  aria-label="Folder path"
                  className="flex flex-wrap items-center gap-0.5 text-xs"
                  data-testid="add-repo__picker-path"
                  data-path={data.path}
                >
                  {crumbsOf(data.path).map((c, i, all) => (
                    <span key={c.path} className="flex items-center gap-0.5">
                      {i > 1 ? (
                        <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
                      ) : null}
                      <button
                        type="button"
                        data-testid="add-repo__crumb"
                        data-path={c.path}
                        aria-current={i === all.length - 1 ? "location" : undefined}
                        onClick={() => browse(c.path)}
                        className={cn(
                          "rounded px-1 py-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          i === all.length - 1 ? "font-medium" : "text-muted-foreground",
                        )}
                      >
                        {c.name}
                      </button>
                    </span>
                  ))}
                  {data.home !== data.path ? (
                    <button
                      type="button"
                      data-testid="add-repo__picker-home"
                      onClick={() => browse(data.home)}
                      className="ml-auto rounded px-1 py-0.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Home
                    </button>
                  ) : null}
                </nav>
                <Input
                  aria-label="Filter folders"
                  data-testid="add-repo__filter"
                  placeholder="Filter folders"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <ul className="max-h-60 overflow-auto rounded-md border" aria-label="Folders">
                  {data.parent ? (
                    <li>
                      <button
                        type="button"
                        data-testid="add-repo__picker-up"
                        onClick={() => browse(data.parent ?? undefined)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      >
                        <Folder className="size-4" aria-hidden /> ..
                      </button>
                    </li>
                  ) : null}
                  {entries.length === 0 ? (
                    <li className="px-3 py-2 text-sm text-muted-foreground">
                      {filter.trim() ? "No folder matches." : "No folders here."}
                    </li>
                  ) : null}
                  {entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        data-testid="add-repo__picker-entry"
                        data-name={entry.name}
                        data-git={entry.isGit ? "true" : "false"}
                        onClick={() => browse(entry.path)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      >
                        {entry.isGit ? (
                          <FolderGit2 className="size-4 text-primary" aria-hidden />
                        ) : (
                          <Folder className="size-4 text-muted-foreground" aria-hidden />
                        )}
                        <span className="truncate">{entry.name}</span>
                        {entry.isGit ? (
                          <span className="ml-auto text-xs text-muted-foreground">git</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={busy}
                    data-testid="add-repo__picker-select"
                    onClick={() => setSelected(data.path)}
                  >
                    Use this folder
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="add-repo-url">Remote URL</Label>
            <Input
              id="add-repo-url"
              data-testid="add-repo__url"
              placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          {lookupUrl !== "" && resolved.isFetching ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Asking the remote for its default branch
            </div>
          ) : resolved.error && lookupUrl !== "" ? (
            <p className="text-sm text-muted-foreground" data-testid="add-repo__url-unresolved">
              {errorText(resolved.error)}
            </p>
          ) : resolved.data && lookupUrl === remoteUrl.trim() ? (
            <dl
              className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 rounded-lg border p-3 text-sm"
              data-testid="add-repo__url-preview"
            >
              <dt className="text-muted-foreground">Repo name</dt>
              <dd>{resolved.data.name}</dd>
              <dt className="text-muted-foreground">Default branch</dt>
              <dd data-testid="add-repo__url-resolved-branch">{resolved.data.defaultBranch}</dd>
            </dl>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="add-repo-branch">Default branch</Label>
            <Input
              id="add-repo-branch"
              data-testid="add-repo__branch"
              placeholder={
                resolved.data?.defaultBranch
                  ? `${resolved.data.defaultBranch} (from the remote)`
                  : "Optional. The hub asks the remote when empty."
              }
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || remoteUrl.trim() === ""}
              data-testid="add-repo__url-submit"
              onClick={addByUrl}
            >
              {busy ? <Spinner className="size-4" /> : null}
              Add repo
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" data-testid="add-repo__error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface Props extends Omit<AddRepoFormProps, "active"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The Add repo dialog of the sidebar's Repos panel. */
export function AddRepoDialog({ open, onOpenChange, onAdded, ...form }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]" data-testid="add-repo__dialog">
        <DialogHeader>
          <DialogTitle>Add repo</DialogTitle>
          <DialogDescription>
            A repo is its remote URL and default branch. Each worker keeps its own clone.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <AddRepoForm
            {...form}
            onAdded={(name) => {
              onAdded?.(name);
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
