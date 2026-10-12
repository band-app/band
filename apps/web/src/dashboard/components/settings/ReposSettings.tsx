import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useHostNames } from "../../hooks/use-host-names";
import { useRepos } from "../../hooks/use-repos";
import type { RepoInfo } from "../../types";
import { RepoHostsFields, type RepoHostsValue, repoHostsValid } from "../RepoHostsFields";
import { useIsAdmin } from "./DevicesSettings";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Where a repo may run and which host lists its default branch, with a Save button. */
function RepoHostsEditor({ repo }: { repo: RepoInfo }) {
  const queryClient = useQueryClient();
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  const stored: RepoHostsValue = {
    allowedHostIds: repo.allowedHostIds ?? null,
    primaryHostId: repo.primaryHostId ?? "",
  };
  const [edit, setEdit] = useState<RepoHostsValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = edit ?? stored;
  const options = (hosts.data ?? [])
    .filter((h) => h.usable)
    .map((h) => ({ id: h.id, name: h.name }));

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await trpc.repos.update.mutate({
        name: repo.name,
        allowedHostIds: value.allowedHostIds,
        primaryHostId: value.primaryHostId || null,
      });
      setEdit(null);
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="settings-repos__hosts">
      <RepoHostsFields
        hosts={options}
        value={value}
        onChange={setEdit}
        idPrefix={`settings-repo-${repo.name}`}
        disabled={saving}
      />
      {edit ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
            Reset
          </Button>
          <Button
            size="sm"
            data-testid="settings-repos__hosts-save"
            disabled={saving || !repoHostsValid(value)}
            onClick={save}
          >
            Save hosts
          </Button>
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid="settings-repos__hosts-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether the hub keeps checkpoints of the repo's worktrees on static workers. Without a stored
 * choice the repo follows the default: on when it is available on every host, off when it is
 * limited to chosen hosts, because limiting a repo usually means its code must stay off other
 * machines.
 */
function CheckpointsSwitch({ repo }: { repo: RepoInfo }) {
  const queryClient = useQueryClient();
  const admin = useIsAdmin();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled = repo.checkpointsEnabled ?? !repo.allowedHostIds;
  const followsDefault = (repo.checkpointsSetting ?? null) === null;

  const change = async (next: boolean) => {
    setError(null);
    setSaving(true);
    try {
      await trpc.repos.update.mutate({ name: repo.name, checkpointsEnabled: next });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const id = `settings-repo-${repo.name}-checkpoints`;
  return (
    <div className="space-y-1" data-testid="settings-repos__checkpoints">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={enabled}
          disabled={!admin || saving}
          aria-label={`Checkpoints on the hub for ${repo.name}`}
          data-testid="settings-repos__checkpoints-switch"
          onChange={(e) => void change(e.target.checked)}
        />
        <label htmlFor={id} className="text-xs font-medium">
          Checkpoints on the hub
        </label>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="settings-repos__checkpoints-note">
        {enabled
          ? "The hub keeps recent copies of this repo's uncommitted work, so a worktree stays readable when its host goes offline and can be restored on another host."
          : "The hub stores nothing for this repo. If a host goes offline its uncommitted work cannot be restored elsewhere."}
        {followsDefault
          ? enabled
            ? " On by default because the repo is available on all hosts."
            : " Off by default because the repo is limited to chosen hosts."
          : ""}
      </p>
      {admin ? null : (
        <p className="text-xs text-muted-foreground">Changing this needs an admin token.</p>
      )}
      {error ? (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid="settings-repos__checkpoints-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether a worktree whose host is offline continues on another host without a prompt. It
 * applies while the newest checkpoint is younger than 30 minutes; an older one always asks.
 */
function AutoContinueSwitch({ repo }: { repo: RepoInfo }) {
  const queryClient = useQueryClient();
  const admin = useIsAdmin();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled = repo.autoContinue ?? false;

  const change = async (next: boolean) => {
    setError(null);
    setSaving(true);
    try {
      await trpc.repos.update.mutate({ name: repo.name, autoContinue: next });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const id = `settings-repo-${repo.name}-auto-continue`;
  return (
    <div className="space-y-1" data-testid="settings-repos__auto-continue">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={enabled}
          disabled={!admin || saving}
          aria-label={`Continue on another host automatically for ${repo.name}`}
          data-testid="settings-repos__auto-continue-switch"
          onChange={(e) => void change(e.target.checked)}
        />
        <label htmlFor={id} className="text-xs font-medium">
          Continue on another host automatically
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        When a worktree's host is offline and you message, open a terminal in or start an agent
        there, Band continues it on another allowed host without asking, if its checkpoint is
        younger than 30 minutes. An older checkpoint always asks. Needs checkpoints.
      </p>
      {admin ? null : (
        <p className="text-xs text-muted-foreground">Changing this needs an admin token.</p>
      )}
      {error ? (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid="settings-repos__auto-continue-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Settings dialog's Repos section, a registry with no add: every repo the hub knows with its
 * remote URL, default branch, the folder each host keeps it in,.
 * Adding a repo happens in the sidebar's Repos panel. A repo can be removed here once it has no
 * worktrees, and removing it leaves every folder alone.
 */
export function ReposSettings() {
  const hostName = useHostNames();
  const queryClient = useQueryClient();
  const { repos } = useRepos();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const remove = async (name: string) => {
    setError(null);
    try {
      await trpc.repos.remove.mutate({ name });
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-3" data-testid="settings-repos">
      <p className="text-xs text-muted-foreground">
        Add a repo from the Repos panel in the sidebar. A repo is its remote URL and default branch,
        and each worker keeps its own folder for it.
      </p>
      {repos.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-repos__empty">
          No repos yet. Add one from the Repos panel in the sidebar.
        </p>
      ) : null}
      <ul className="space-y-2">
        {repos.map((repo) => {
          const worktrees = repo.worktrees.filter((w) => w.path !== repo.path).length;
          const inUse = worktrees > 0;
          return (
            <li
              key={repo.name}
              className="space-y-1.5 rounded-md border p-3"
              data-testid="settings-repos__row"
              data-repo={repo.name}
              data-in-use={inUse ? "true" : "false"}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{repo.name}</span>
                {confirming === repo.name ? (
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      data-testid="settings-repos__remove-confirm"
                      onClick={() => remove(repo.name)}
                    >
                      Confirm remove
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Remove ${repo.name}`}
                    data-testid="settings-repos__remove"
                    disabled={inUse}
                    title={inUse ? `${worktrees} worktree${worktrees === 1 ? "" : "s"}` : undefined}
                    onClick={() => setConfirming(repo.name)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <p
                className="break-all text-xs text-muted-foreground"
                data-testid="settings-repos__url"
              >
                {repo.remoteUrl ?? "No remote. This repo lives on one host only."}
              </p>
              <p className="text-xs text-muted-foreground" data-testid="settings-repos__branch">
                Default branch {repo.defaultBranch}
                {repo.label ? ` · label ${repo.label}` : ""}
              </p>
              <ul className="text-xs text-muted-foreground" data-testid="settings-repos__clones">
                {(repo.clones ?? []).length === 0 ? (
                  <li>Not cloned anywhere yet. The first worktree on a worker clones it.</li>
                ) : null}
                {(repo.clones ?? []).map((c) => (
                  <li key={c.hostId} data-host={c.hostId}>
                    {hostName(c.hostId)}: <span className="font-mono">{c.path}</span>
                  </li>
                ))}
              </ul>
              <RepoHostsEditor repo={repo} />
              <CheckpointsSwitch repo={repo} />
              <AutoContinueSwitch repo={repo} />
              {inUse ? (
                <p className="text-xs text-muted-foreground" data-testid="settings-repos__in-use">
                  Remove its worktrees before removing it here.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
