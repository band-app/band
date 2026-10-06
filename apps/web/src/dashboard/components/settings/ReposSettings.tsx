import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useRepos } from "../../hooks/use-repos";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Rows for the Settings dialog's Repos section: every repo the hub knows with its remote URL,
 * default branch, the folder each host keeps it in, and its projects. Adding a repo happens in a
 * project. Removing one here forgets it on the hub and leaves every folder alone.
 */
export function ReposSettings() {
  const queryClient = useQueryClient();
  const { repos } = useRepos();
  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: async () => (await trpc.projects.list.query()).projects,
  });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const projectsOf = (repo: string) =>
    (projects.data ?? [])
      .filter((p) => p.repos.some((r) => r.repo === repo))
      .map((p) => (p.isDefault ? "Personal" : p.name));

  const remove = async (name: string) => {
    setError(null);
    try {
      await trpc.repos.remove.mutate({ name });
      setConfirming(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["repos"] }),
        queryClient.invalidateQueries({ queryKey: ["projects.list"] }),
      ]);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-3" data-testid="settings-repos">
      <p className="text-xs text-muted-foreground">
        Add a repo from inside a project. A repo is its remote URL and default branch, and each
        worker keeps its own folder for it.
      </p>
      {repos.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-repos__empty">
          No repos yet.
        </p>
      ) : null}
      <ul className="space-y-2">
        {repos.map((repo) => (
          <li
            key={repo.name}
            className="space-y-1 rounded-md border p-3"
            data-testid="settings-repos__row"
            data-repo={repo.name}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{repo.name}</span>
              {confirming === repo.name ? (
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="settings-repos__remove-confirm"
                  onClick={() => remove(repo.name)}
                >
                  Confirm remove
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Remove ${repo.name}`}
                  data-testid="settings-repos__remove"
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
            <p className="text-xs text-muted-foreground">
              Default branch {repo.defaultBranch}
              {repo.label ? ` · label ${repo.label}` : ""}
              {projectsOf(repo.name).length > 0 ? ` · ${projectsOf(repo.name).join(", ")}` : ""}
            </p>
            <ul className="text-xs text-muted-foreground" data-testid="settings-repos__clones">
              {(repo.clones ?? []).length === 0 ? (
                <li>Not cloned anywhere yet. The first worktree on a worker clones it.</li>
              ) : null}
              {(repo.clones ?? []).map((c) => (
                <li key={c.hostId} data-host={c.hostId}>
                  {c.hostId}: {c.path}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
