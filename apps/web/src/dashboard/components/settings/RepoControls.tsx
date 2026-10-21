import { Button, Switch } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import type { RepoInfo } from "../../types";
import { RepoHostsFields, type RepoHostsValue, repoHostsValid } from "../RepoHostsFields";
import { useIsAdmin } from "./DevicesSettings";
import { SettingsRow } from "./SettingsRow";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The hub's hosts. Shared with every other `hosts.list` reader through the query key. */
export function useHostsList() {
  return useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
}

/** Where a repo may run and which worker lists its default branch, with a Save button. */
export function RepoHostsEditor({ repo }: { repo: RepoInfo }) {
  const queryClient = useQueryClient();
  const hosts = useHostsList();
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
    <div className="space-y-2 px-4 py-3" data-testid="settings-repo__hosts">
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
            data-testid="settings-repo__hosts-save"
            disabled={saving || !repoHostsValid(value)}
            onClick={save}
          >
            Save workers
          </Button>
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid="settings-repo__hosts-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether the hub keeps checkpoints of the repo's worktrees on static workers. Without a stored
 * choice the repo follows the default: on when it is available on every worker, off when it is
 * limited to chosen workers, because limiting a repo usually means its code must stay off other
 * machines.
 */
export function CheckpointsSwitch({ repo }: { repo: RepoInfo }) {
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
    <SettingsRow
      htmlFor={id}
      label="Checkpoints on the hub"
      description={
        <span data-testid="settings-repo__checkpoints-note">
          {enabled
            ? "The hub keeps recent copies of this repo's uncommitted work, so a worktree stays readable when its worker goes offline and can be restored on another worker."
            : "The hub stores nothing for this repo. If a worker goes offline its uncommitted work cannot be restored elsewhere."}
          {followsDefault
            ? enabled
              ? " On by default because the repo is available on all workers."
              : " Off by default because the repo is limited to chosen workers."
            : ""}
          {admin ? "" : " Changing this needs an admin token."}
          {error ? (
            <span
              role="alert"
              className="block text-destructive"
              data-testid="settings-repo__checkpoints-error"
            >
              {error}
            </span>
          ) : null}
        </span>
      }
    >
      <Switch
        id={id}
        checked={enabled}
        disabled={!admin || saving}
        aria-label={`Checkpoints on the hub for ${repo.name}`}
        data-testid="settings-repo__checkpoints-switch"
        onCheckedChange={(next: boolean) => void change(next)}
      />
    </SettingsRow>
  );
}

/**
 * Whether a worktree whose worker is offline continues on another worker without a prompt. It
 * applies while the newest checkpoint is younger than 30 minutes; an older one always asks.
 */
export function AutoContinueSwitch({ repo }: { repo: RepoInfo }) {
  const queryClient = useQueryClient();
  const admin = useIsAdmin();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled = repo.autoContinue ?? false;
  const singleWorker = repo.allowedHostIds?.length === 1;

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
    <SettingsRow
      htmlFor={id}
      label="Continue automatically"
      description={
        <span data-testid="settings-repo__auto-continue-note">
          When a worktree's worker is offline and you message, open a terminal in or start an agent
          there, Band continues it on another allowed worker without asking, if its checkpoint is
          younger than 30 minutes. An older checkpoint always asks. Needs checkpoints.
          {singleWorker
            ? " This repo has one allowed worker, so there is none to continue on."
            : ""}
          {admin ? "" : " Changing this needs an admin token."}
          {error ? (
            <span
              role="alert"
              className="block text-destructive"
              data-testid="settings-repo__auto-continue-error"
            >
              {error}
            </span>
          ) : null}
        </span>
      }
    >
      <Switch
        id={id}
        checked={enabled}
        disabled={!admin || saving}
        aria-label={`Continue on another worker automatically for ${repo.name}`}
        data-testid="settings-repo__auto-continue-switch"
        onCheckedChange={(next: boolean) => void change(next)}
      />
    </SettingsRow>
  );
}
