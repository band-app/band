import { Button } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useHostNames } from "../../hooks/use-host-names";
import { useRepos } from "../../hooks/use-repos";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
