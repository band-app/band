import { Input } from "@band-app/ui";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRepos } from "../../hooks/use-repos";
import { useHostsList } from "../../hooks/use-update-status";
import type { RepoInfo } from "../../types";
import { RepoAvatar } from "../RepoAvatar";

/** The worktrees a repo counts as in use: every listed worktree but the hub's own checkout. */
export function repoWorktreeCount(repo: RepoInfo): number {
  return repo.worktrees.filter((w) => w.path !== repo.path).length;
}

/** Whether the repo may run on the worker: a repo with no list runs on every worker. */
function allowsWorker(repo: RepoInfo, hostId: string): boolean {
  return !repo.allowedHostIds || repo.allowedHostIds.includes(hostId);
}

function matchesQuery(repo: RepoInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [repo.name, repo.remoteUrl ?? ""].some((text) => text.toLowerCase().includes(q));
}

const ALL = "";

/**
 * Settings > Repos: every repo on the hub in one list, each with its name, remote
 * and, for a repo limited to some workers, which ones. The filter has focus when the page opens,
 * and Enter opens the first repo that matches it. A row opens the repo's page. Repos are added
 * from the Repos panel in the sidebar.
 */
export function ReposOverview({ onOpen }: { onOpen: (name: string) => void }) {
  const { repos } = useRepos();
  const hosts = useHostsList();
  const [query, setQuery] = useState("");
  const [worker, setWorker] = useState(ALL);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  const workerName = (id: string) => hosts.data?.find((h) => h.id === id)?.name ?? id;
  const visible = repos.filter(
    (repo) => matchesQuery(repo, query) && (worker === ALL || allowsWorker(repo, worker)),
  );

  return (
    <div className="space-y-3" data-testid="settings-repos">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          ref={filterRef}
          aria-label="Filter repos"
          placeholder="Filter by name or URL. Enter opens the first match"
          value={query}
          data-testid="settings-repos__filter"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter" && visible[0]) {
              e.preventDefault();
              onOpen(visible[0].name);
            }
          }}
          className="h-8 flex-1 text-sm"
        />
        <select
          aria-label="Filter repos by worker"
          data-testid="settings-repos__worker-filter"
          value={worker}
          onChange={(e) => setWorker(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value={ALL}>All workers</option>
          {(hosts.data ?? []).map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </div>

      {repos.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-repos__empty">
          No repos yet. Add one from the Repos panel in the sidebar.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-repos__no-match">
          No repo matches the filters.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border divide-y divide-border">
          {visible.map((repo) => {
            const limitedTo = repo.allowedHostIds?.map(workerName).join(", ");
            return (
              <li key={repo.name}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-list-highlight"
                  data-testid="settings-repos__row"
                  data-repo={repo.name}
                  data-limited={repo.allowedHostIds ? "true" : "false"}
                  onClick={() => onOpen(repo.name)}
                >
                  <RepoAvatar
                    name={repo.name}
                    avatar={repo.avatar}
                    className="size-5"
                    textClassName="text-[11px]"
                    testId="settings-repos__avatar"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">{repo.name}</span>
                    <span
                      className="truncate font-mono text-xs text-muted-foreground"
                      data-testid="settings-repos__url"
                    >
                      {repo.remoteUrl ?? "no remote"}
                    </span>
                  </span>
                  {limitedTo ? (
                    <span
                      className="shrink-0 text-xs text-muted-foreground"
                      data-testid="settings-repos__limited"
                    >
                      {limitedTo} only
                    </span>
                  ) : null}
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
