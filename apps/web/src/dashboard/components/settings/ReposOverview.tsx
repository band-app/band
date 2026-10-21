import { Input } from "@band-app/ui";
import { useEffect, useRef, useState } from "react";
import { useRepos } from "../../hooks/use-repos";
import { useSettingsQuery } from "../../hooks/use-settings-query";
import type { LabelDefinition, RepoInfo } from "../../types";
import { useAgentLogins, useLoginAgents } from "./AgentLoginsSettings";
import { useHostsList } from "./RepoControls";

/** The worktrees a repo counts as in use: every listed worktree but the hub's own checkout. */
export function repoWorktreeCount(repo: RepoInfo): number {
  return repo.worktrees.filter((w) => w.path !== repo.path).length;
}

/** Whether the repo may run on the worker: a repo with no list runs on every worker. */
function allowsWorker(repo: RepoInfo, hostId: string): boolean {
  return !repo.allowedHostIds || repo.allowedHostIds.includes(hostId);
}

function matchesQuery(repo: RepoInfo, labels: LabelDefinition[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const label = labels.find((l) => l.id === repo.label)?.name ?? "";
  return [repo.name, repo.remoteUrl ?? "", label].some((text) => text.toLowerCase().includes(q));
}

const ALL = "";

/**
 * Settings > Repos: every repo on the hub in one table, with the settings people scan for. The
 * filter has focus when the page opens, and Enter opens the first repo that matches it. A row opens
 * the repo's page. Repos are added from the Repos panel in the sidebar.
 */
export function ReposOverview({ onOpen }: { onOpen: (name: string) => void }) {
  const { repos } = useRepos();
  const { settings } = useSettingsQuery();
  const labels = settings.labels ?? [];
  const hosts = useHostsList();
  const logins = useAgentLogins();
  const loginAgents = useLoginAgents();
  const [query, setQuery] = useState("");
  const [worker, setWorker] = useState(ALL);
  const [label, setLabel] = useState(ALL);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  const workerName = (id: string) => hosts.data?.find((h) => h.id === id)?.name ?? id;
  const visible = repos.filter(
    (repo) =>
      matchesQuery(repo, labels, query) &&
      (worker === ALL || allowsWorker(repo, worker)) &&
      (label === ALL || repo.label === label),
  );

  const overridesOf = (repoName: string) =>
    (logins.data?.repoOverrides ?? [])
      .filter((o) => o.repo === repoName)
      .map((o) => {
        const agent = loginAgents.find((a) => a.type === o.agentType)?.label ?? o.agentType;
        const login = logins.data?.logins.find((l) => l.id === o.loginId)?.label ?? o.loginId;
        return `${agent}: ${login}`;
      });

  return (
    <div className="space-y-3" data-testid="settings-repos">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          ref={filterRef}
          aria-label="Filter repos"
          placeholder="Filter by name, URL or label. Enter opens the first match"
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
        <select
          aria-label="Filter repos by label"
          data-testid="settings-repos__label-filter"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value={ALL}>Any label</option>
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
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
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Repo</th>
                <th className="px-3 py-2 font-medium">Remote</th>
                <th className="px-3 py-2 font-medium">Workers</th>
                <th className="px-3 py-2 font-medium">Worktrees</th>
                <th className="px-3 py-2 font-medium">Checkpoints</th>
                <th className="px-3 py-2 font-medium">Logins</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((repo) => {
                const repoLabel = labels.find((l) => l.id === repo.label);
                const checkpoints = repo.checkpointsEnabled ?? !repo.allowedHostIds;
                const overrides = overridesOf(repo.name);
                return (
                  <tr
                    key={repo.name}
                    className="cursor-pointer align-middle hover:bg-accent/40"
                    data-testid="settings-repos__row"
                    data-repo={repo.name}
                    onClick={() => onOpen(repo.name)}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="flex items-center gap-2 text-left font-medium hover:underline"
                        data-testid="settings-repos__open"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(repo.name);
                        }}
                      >
                        {repoLabel ? (
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-[3px]"
                            style={{ backgroundColor: repoLabel.color }}
                          />
                        ) : null}
                        {repo.name}
                      </button>
                    </td>
                    <td
                      className="max-w-56 truncate px-3 py-2 font-mono text-xs text-muted-foreground"
                      title={repo.remoteUrl}
                      data-testid="settings-repos__url"
                    >
                      {repo.remoteUrl ?? "no remote"}
                    </td>
                    <td className="px-3 py-2 text-xs" data-testid="settings-repos__workers">
                      {repo.allowedHostIds
                        ? `${repo.allowedHostIds.map(workerName).join(", ") || "none"} only`
                        : "all workers"}
                    </td>
                    <td className="px-3 py-2 text-xs" data-testid="settings-repos__worktrees">
                      {repoWorktreeCount(repo)}
                    </td>
                    <td
                      className="px-3 py-2 text-xs"
                      data-testid="settings-repos__checkpoints"
                      data-enabled={checkpoints ? "true" : "false"}
                    >
                      {checkpoints ? "on" : "off"}
                    </td>
                    <td className="px-3 py-2 text-xs" data-testid="settings-repos__logins">
                      {overrides.length > 0 ? (
                        overrides.join(", ")
                      ) : (
                        <span className="text-muted-foreground">defaults</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
