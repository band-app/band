import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
} from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useHostsList } from "../../hooks/use-update-status";
import type { RepoInfo } from "../../types";
import { useIsAdmin } from "./DevicesSettings";
import { Chip, errorText, Hint, RepoRow, SELECT_CLASS } from "./repo-page-ui";

type HostList = NonNullable<ReturnType<typeof useHostsList>["data"]>;
type Host = HostList[number];

/** The worktrees each worker holds for the repo, leaving out the hub's own checkout. */
function worktreesPerWorker(repo: RepoInfo): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of repo.worktrees) {
    if (w.path === repo.path) continue;
    const host = w.hostId ?? "local";
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return counts;
}

/**
 * The workers the list shows. A repo limited to workers lists those first. A repo allowed
 * everywhere lists every usable worker, so any of them can be made primary. Both also list any
 * other worker that still holds a clone or a worktree of it, so a worker the repo is no longer
 * allowed on keeps showing its folder and worktrees.
 */
function listedWorkers(repo: RepoInfo, counts: Map<string, number>, usable: string[]): string[] {
  const ids = [
    ...(repo.allowedHostIds ?? usable),
    ...(repo.clones ?? []).map((c) => c.hostId),
    ...counts.keys(),
    ...(!repo.allowedHostIds && repo.primaryHostId ? [repo.primaryHostId] : []),
  ];
  return [...new Set(ids)];
}

/**
 * The dialog behind "Add worker…": a filter that has focus, and every usable worker with its
 * labels and status. A worker the repo already allows is greyed out. Enter or a click adds the
 * highlighted worker and closes the dialog.
 */
function AddWorkerDialog({
  open,
  onOpenChange,
  repoName,
  hosts,
  allowed,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoName: string;
  hosts: Host[];
  allowed: string[];
  onAdd: (hostId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();
  const shown = hosts.filter(
    (h) =>
      !q ||
      h.name.toLowerCase().includes(q) ||
      h.labels.some((label) => label.toLowerCase().includes(q)),
  );
  const addable = shown.filter((h) => !allowed.includes(h.id));
  const activeId = addable[Math.min(active, addable.length - 1)]?.id;

  // Every way out (Escape, the overlay, Cancel, adding) clears the filter for the next open.
  const close = () => {
    setQuery("");
    setActive(0);
    onOpenChange(false);
  };
  const add = (hostId: string) => {
    onAdd(hostId);
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="gap-3 sm:max-w-md" data-testid="settings-repo__add-worker-dialog">
        <DialogHeader>
          <DialogTitle>Add a worker</DialogTitle>
          <DialogDescription>
            {repoName} may then run on it. Its clone is made with the first worktree there.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="Filter workers"
          placeholder="Filter by name or label"
          value={query}
          data-testid="settings-repo__add-worker-filter"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, addable.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && activeId) {
              e.preventDefault();
              add(activeId);
            }
          }}
        />
        {shown.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No worker matches.</p>
        ) : (
          <ul className="max-h-64 space-y-0.5 overflow-y-auto">
            {shown.map((h) => {
              const added = allowed.includes(h.id);
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    disabled={added}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left",
                      added ? "text-muted-foreground" : "hover:bg-accent",
                      h.id === activeId && "bg-accent",
                    )}
                    data-testid="settings-repo__add-worker-option"
                    data-host={h.id}
                    data-added={added ? "true" : "false"}
                    onClick={() => add(h.id)}
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-sm font-semibold">{h.name}</span>
                      {h.labels.length > 0 ? (
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          {h.labels.join(", ")}
                        </span>
                      ) : null}
                    </span>
                    {added ? (
                      <Hint>added</Hint>
                    ) : (
                      <Chip tone={h.status === "online" ? "ok" : "neutral"}>{h.status}</Chip>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            ↑↓ to move · Enter to add · Esc to close
          </span>
          <Button variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Workers section's rows: where the repo may run ("All workers" or "Only these", with "Add
 * worker…"), then each listed worker with its clone folder, its worktree count, a Primary switch
 * and, for a limited repo, Remove. Every change saves at once through `repos.update`.
 */
export function RepoWorkers({ repo }: { repo: RepoInfo }) {
  const queryClient = useQueryClient();
  const admin = useIsAdmin();
  const hosts = useHostsList();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const usable = (hosts.data ?? []).filter((h) => h.usable);
  const counts = worktreesPerWorker(repo);
  const listed = listedWorkers(
    repo,
    counts,
    usable.map((h) => h.id),
  );
  const allowed = repo.allowedHostIds ?? null;
  const primary = repo.primaryHostId ?? null;
  const locked = !admin || saving;

  const save = async (policy: { allowedHostIds?: string[] | null; primaryHostId?: string }) => {
    setError(null);
    setSaving(true);
    try {
      await trpc.repos.update.mutate({ name: repo.name, ...policy });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  // "Only these" starts from one worker: the primary, else one that holds a clone, else any usable one.
  const firstWorker = primary ?? (repo.clones ?? [])[0]?.hostId ?? usable[0]?.id;
  const chooseMode = (mode: string) => {
    if (mode === "all") return void save({ allowedHostIds: null });
    if (firstWorker) void save({ allowedHostIds: [firstWorker] });
  };

  const remove = (hostId: string) => {
    if (!allowed) return;
    const next = allowed.filter((id) => id !== hostId);
    void save({
      allowedHostIds: next,
      ...(hostId === primary && next[0] ? { primaryHostId: next[0] } : {}),
    });
  };

  const modeId = `settings-repo-${repo.name}-allowed`;
  return (
    <>
      <RepoRow
        label="Allowed workers"
        description="Worktrees and checkpoints only go to these."
        htmlFor={modeId}
      >
        <select
          id={modeId}
          className={SELECT_CLASS}
          value={allowed ? "only" : "all"}
          disabled={locked}
          data-testid="settings-repo__allowed-mode"
          onChange={(e) => chooseMode(e.target.value)}
        >
          <option value="all">All workers</option>
          <option value="only" disabled={!allowed && !firstWorker}>
            Only these
          </option>
        </select>
        {allowed ? (
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            data-testid="settings-repo__add-worker"
            onClick={() => setAdding(true)}
          >
            Add worker…
          </Button>
        ) : null}
        {admin ? null : <Hint>Changing this needs an admin token.</Hint>}
      </RepoRow>

      <div className="px-4 py-1">
        {listed.length === 0 ? (
          <p
            className="py-2 text-xs text-muted-foreground"
            data-testid="settings-repo__clones-none"
          >
            Not cloned anywhere yet. The first worktree on a worker clones it.
          </p>
        ) : (
          <ul className="divide-y divide-dashed divide-border" data-testid="settings-repo__clones">
            {listed.map((hostId) => {
              const host = hosts.data?.find((h) => h.id === hostId);
              const path = repo.clones?.find((c) => c.hostId === hostId)?.path;
              const count = counts.get(hostId) ?? 0;
              const isPrimary = hostId === primary;
              const notAllowed = allowed ? !allowed.includes(hostId) : false;
              const name = host?.name?.trim() || hostId;
              return (
                <li
                  key={hostId}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5"
                  data-testid="settings-repo__clone"
                  data-host={hostId}
                  data-worktrees={count}
                  data-primary={isPrimary ? "true" : "false"}
                  data-allowed={notAllowed ? "false" : "true"}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{name}</span>
                      {host ? (
                        <Chip tone={host.status === "online" ? "ok" : "neutral"}>
                          {host.status}
                        </Chip>
                      ) : null}
                      {notAllowed ? <Chip tone="warn">not allowed</Chip> : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {path ?? "No clone yet"}
                    </div>
                  </div>
                  <Hint>
                    {count} worktree{count === 1 ? "" : "s"}
                  </Hint>
                  {notAllowed ? null : (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        id={`settings-repo-${repo.name}-primary-${hostId}`}
                        checked={isPrimary}
                        disabled={locked || isPrimary}
                        aria-label={`Make ${name} the primary worker of ${repo.name}`}
                        data-testid="settings-repo__primary-switch"
                        onCheckedChange={(on: boolean) => {
                          if (on) void save({ primaryHostId: hostId });
                        }}
                      />
                      <label htmlFor={`settings-repo-${repo.name}-primary-${hostId}`}>
                        Primary
                      </label>
                    </span>
                  )}
                  {allowed && !notAllowed ? (
                    // A disabled button gets no pointer events, so the tooltip sits on a wrapper.
                    <span
                      title={
                        allowed.length === 1
                          ? "A limited repo needs at least one worker"
                          : undefined
                      }
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={locked || allowed.length === 1}
                        aria-label={`Remove ${name} from ${repo.name}`}
                        data-testid="settings-repo__remove-worker"
                        onClick={() => remove(hostId)}
                      >
                        Remove
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {error ? (
          <p
            role="alert"
            className="pb-2 text-xs text-destructive"
            data-testid="settings-repo__workers-error"
          >
            {error}
          </p>
        ) : null}
      </div>

      {allowed ? (
        <AddWorkerDialog
          open={adding}
          onOpenChange={setAdding}
          repoName={repo.name}
          hosts={usable}
          allowed={allowed}
          onAdd={(hostId) => void save({ allowedHostIds: [...allowed, hostId] })}
        />
      ) : null}
    </>
  );
}
