import { Switch } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import type { RepoInfo } from "../../types";
import { useIsAdmin } from "./DevicesSettings";
import { errorText, Hint, RepoRow } from "./repo-page-ui";

/** Saves one continuity field through `repos.update` and refreshes the repo list. */
function useRepoSwitch(repoName: string, field: "checkpointsEnabled" | "autoContinue") {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = async (next: boolean) => {
    setError(null);
    setSaving(true);
    try {
      await trpc.repos.update.mutate({ name: repoName, [field]: next });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  return { error, saving, change };
}

/**
 * Whether the hub keeps checkpoints of the repo's worktrees on static workers. Without a stored
 * choice the repo follows the default: on when it is available on every worker, off when it is
 * limited to chosen workers, because limiting a repo usually means its code must stay off other
 * machines.
 */
export function CheckpointsSwitch({ repo }: { repo: RepoInfo }) {
  const admin = useIsAdmin();
  const { error, saving, change } = useRepoSwitch(repo.name, "checkpointsEnabled");
  const enabled = repo.checkpointsEnabled ?? !repo.allowedHostIds;
  const followsDefault = (repo.checkpointsSetting ?? null) === null;
  const id = `settings-repo-${repo.name}-checkpoints`;
  return (
    <RepoRow
      htmlFor={id}
      label="Checkpoints on the hub"
      description="Recent snapshots of each worktree, so another worker can continue it."
    >
      <Switch
        id={id}
        checked={enabled}
        disabled={!admin || saving}
        aria-label={`Checkpoints on the hub for ${repo.name}`}
        data-testid="settings-repo__checkpoints-switch"
        onCheckedChange={(next: boolean) => void change(next)}
      />
      <span
        className="text-xs text-muted-foreground"
        data-testid="settings-repo__checkpoints-note"
        data-default={followsDefault ? (enabled ? "all-workers" : "limited") : "stored"}
      >
        {followsDefault
          ? enabled
            ? "On by default for a repo allowed on all workers"
            : "Off by default for a limited repo, so its code stays on its workers"
          : enabled
            ? "On"
            : "Off"}
      </span>
      {admin ? null : <Hint>Changing this needs an admin token.</Hint>}
      {error ? (
        <p
          role="alert"
          className="w-full text-xs text-destructive"
          data-testid="settings-repo__checkpoints-error"
        >
          {error}
        </p>
      ) : null}
    </RepoRow>
  );
}

/**
 * Whether a worktree whose worker is offline continues on another worker without a prompt. It
 * applies while the newest checkpoint is younger than 30 minutes; an older one always asks. A repo
 * with one allowed worker has nowhere to continue, so the switch is off and disabled there.
 */
export function AutoContinueSwitch({ repo }: { repo: RepoInfo }) {
  const admin = useIsAdmin();
  const { error, saving, change } = useRepoSwitch(repo.name, "autoContinue");
  const singleWorker = repo.allowedHostIds?.length === 1;
  const enabled = !singleWorker && (repo.autoContinue ?? false);
  const id = `settings-repo-${repo.name}-auto-continue`;
  return (
    <RepoRow
      htmlFor={id}
      label="Continue automatically"
      description={
        singleWorker
          ? "Needs another allowed worker."
          : "Move a worktree to another worker when its worker is offline, if the checkpoint is under 30 minutes old."
      }
    >
      <Switch
        id={id}
        checked={enabled}
        disabled={!admin || saving || singleWorker}
        aria-label={`Continue on another worker automatically for ${repo.name}`}
        data-testid="settings-repo__auto-continue-switch"
        onCheckedChange={(next: boolean) => void change(next)}
      />
      {singleWorker ? (
        <Hint testId="settings-repo__auto-continue-unavailable">Unavailable</Hint>
      ) : null}
      {admin || singleWorker ? null : <Hint>Changing this needs an admin token.</Hint>}
      {error ? (
        <p
          role="alert"
          className="w-full text-xs text-destructive"
          data-testid="settings-repo__auto-continue-error"
        >
          {error}
        </p>
      ) : null}
    </RepoRow>
  );
}
