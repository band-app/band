import { toWorktreeId } from "@band-app/shared/worktree-id";
import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useRepos } from "../../hooks/use-repos";
import { useHostsList } from "../../hooks/use-update-status";
import type { RepoInfo } from "../../types";
import { RepoAvatar } from "../RepoAvatar";
import { RepoLoginOverrides } from "./AgentLoginsSettings";
import { RepoBrowserProfileSelect } from "./BrowserProfilesSettings";
import { useIsAdmin } from "./DevicesSettings";
import { AutoContinueSwitch, CheckpointsSwitch } from "./RepoControls";
import { RepoEnvironmentDetails } from "./RepoEnvironment";
import { repoWorktreeCount } from "./ReposOverview";
import { RepoWorkers } from "./RepoWorkers";
import { Chip, errorText, Hint, RepoRow, RepoSection } from "./repo-page-ui";

/** The MCP servers this repo's chats get: enabled, and scoped to every repo or to this one. */
function RepoMcpServers({ repoName, onOpenMcp }: { repoName: string; onOpenMcp: () => void }) {
  const servers = useQuery({
    queryKey: ["mcp.list"],
    queryFn: () => trpc.mcp.list.query(),
    retry: false,
  });
  if (servers.isLoading) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">Loading…</p>;
  }
  if (servers.isError) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Listing MCP servers needs an admin token.
      </p>
    );
  }
  const reached = (servers.data?.servers ?? []).filter(
    (s) => s.enabled && (!s.scopeRepos || s.scopeRepos.includes(repoName)),
  );
  if (reached.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground" data-testid="settings-repo__mcp-none">
        No MCP server reaches this repo's chats.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-dashed divide-border px-4 py-1">
      {reached.map((server) => {
        const others = (server.scopeRepos ?? []).filter((r) => r !== repoName).length;
        return (
          <li
            key={server.id}
            className="flex items-center justify-between gap-3 py-2.5"
            data-testid="settings-repo__mcp-server"
            data-server={server.name}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">{server.name}</span>
              {server.scopeRepos ? (
                <Chip tone="scoped">
                  {others === 0
                    ? "this repo only"
                    : `this repo and ${others} other${others === 1 ? "" : "s"}`}
                </Chip>
              ) : (
                <Chip>all repos</Chip>
              )}
              {server.scopeHosts ? <Chip tone="scoped">some workers</Chip> : null}
            </div>
            <Button
              size="sm"
              variant="outline"
              data-testid="settings-repo__open-mcp"
              onClick={onOpenMcp}
            >
              Open in MCP
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** The cronjobs of this repo's worktrees, with their schedule, worktree and whether they run. */
function RepoCronjobs({ repo, onOpenCronjobs }: { repo: RepoInfo; onOpenCronjobs?: () => void }) {
  const hosts = useHostsList();
  const jobs = useQuery({
    queryKey: ["cronjobs.list"],
    queryFn: () => trpc.cronjobs.list.query(),
  });
  // `repos.list` leaves out the default-branch worktree of every worker but the primary, and a
  // cronjob on one of those still runs, so the default branch on every worker counts too.
  const worktreeNames = new Map<string, string>([
    ...["local", ...(hosts.data ?? []).map((h) => h.id)].map(
      (hostId) =>
        [toWorktreeId(repo.name, repo.defaultBranch, hostId), repo.defaultBranch] as const,
    ),
    ...repo.worktrees.map(
      (w) => [toWorktreeId(repo.name, w.name, w.hostId ?? "local"), w.name] as const,
    ),
  ]);
  if (jobs.isLoading) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">Loading…</p>;
  }
  if (jobs.isError) {
    return (
      <p role="alert" className="px-4 py-3 text-xs text-destructive">
        Could not list cronjobs: {errorText(jobs.error)}
      </p>
    );
  }
  const mine = (jobs.data?.jobs ?? []).filter(
    (j) => j.worktreeId && worktreeNames.has(j.worktreeId),
  );
  if (mine.length === 0) {
    return (
      <p
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid="settings-repo__cronjobs-none"
      >
        No cronjobs in this repo's worktrees.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-dashed divide-border px-4 py-1">
      {mine.map((job) => (
        <li
          key={`${job.fileKey}:${job.id}`}
          className="flex items-center justify-between gap-3 py-2.5"
          data-testid="settings-repo__cronjob"
          data-cronjob={job.id}
          data-enabled={job.enabled ? "true" : "false"}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{job.name}</span>
              <Chip tone={job.enabled ? "ok" : "neutral"}>{job.enabled ? "on" : "off"}</Chip>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              <span className="font-mono">{job.cronExpression}</span> ·{" "}
              {worktreeNames.get(job.worktreeId ?? "") ?? job.worktreeId}
            </div>
          </div>
          {onOpenCronjobs ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="settings-repo__open-cronjobs"
              onClick={onOpenCronjobs}
            >
              Open in Cronjobs
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Remove, at the top of the page. Disabled while the repo has worktrees, with the reason as its
 * tooltip; asks before it removes.
 */
function RemoveRepo({ repo, onRemoved }: { repo: RepoInfo; onRemoved: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worktrees = repoWorktreeCount(repo);

  const remove = async () => {
    setError(null);
    try {
      await trpc.repos.remove.mutate({ name: repo.name });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
      onRemoved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {confirming ? (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            data-testid="settings-repo__remove-confirm"
            onClick={() => void remove()}
          >
            Confirm remove
          </Button>
        </div>
      ) : (
        // A disabled button gets no pointer events, so the tooltip sits on a wrapper.
        <span
          title={
            worktrees > 0
              ? `Remove its ${worktrees} worktree${worktrees === 1 ? "" : "s"} first`
              : undefined
          }
          data-testid="settings-repo__remove-reason"
        >
          <Button
            size="sm"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Remove ${repo.name}`}
            data-testid="settings-repo__remove"
            disabled={worktrees > 0}
            onClick={() => setConfirming(true)}
          >
            Remove repo…
          </Button>
        </span>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface Props {
  name: string;
  /** Back to the overview. */
  onBack: () => void;
  /** Opens Settings > MCP. */
  onOpenMcp: () => void;
  /** Closes Settings and opens the Cronjobs dialog, when the app has one. */
  onOpenCronjobs?: () => void;
}

/**
 * One repo's settings, opened from the Repos overview: label, workers, agent logins, environment,
 * continuity and browser profile, plus read-only views of the MCP servers and cronjobs that reach
 * it. Every control saves when it changes.
 */
export function RepoSettingsPage({ name, onBack, onOpenMcp, onOpenCronjobs }: Props) {
  const { repos, isLoading } = useRepos();
  const admin = useIsAdmin();
  const hosts = useHostsList();
  const repo = repos.find((r) => r.name === name);

  const crumbs = (
    <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
      <button
        type="button"
        className="underline hover:text-foreground"
        data-testid="settings-repo__back"
        onClick={onBack}
      >
        Repos
      </button>
      <span> / {name}</span>
    </nav>
  );

  if (!repo) {
    return (
      <div className="space-y-2" data-testid="settings-repo" data-repo={name}>
        {crumbs}
        <p className="text-sm text-muted-foreground" data-testid="settings-repo__missing">
          {isLoading ? "Loading…" : `There is no repo named ${name}.`}
        </p>
      </div>
    );
  }

  const workerName = (id: string) => hosts.data?.find((h) => h.id === id)?.name?.trim() || id;

  return (
    <div className="space-y-4" data-testid="settings-repo" data-repo={repo.name}>
      <header className="space-y-1">
        {crumbs}
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <RepoAvatar
              name={repo.name}
              avatar={repo.avatar}
              className="size-[38px]"
              textClassName="text-lg"
              testId="settings-repo__avatar"
            />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold" data-testid="settings-repo__title">
                {repo.name}
              </h1>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {repo.remoteUrl ?? "No remote"}
              </p>
            </div>
          </div>
          <RemoveRepo repo={repo} onRemoved={onBack} />
        </div>
      </header>

      {repo.allowedHostIds ? (
        <p
          className="rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs"
          data-testid="settings-repo__limited-note"
        >
          This repo is limited to{" "}
          <b>{repo.allowedHostIds.map(workerName).join(", ") || "no worker"}</b>. Checkpoints are
          off by default for a limited repo, and it cannot continue on a worker it isn't allowed on.
        </p>
      ) : null}

      <RepoSection title="General" description="How the repo is named and shown." from="from Repos">
        <RepoRow label="Remote" description="The repo's identity on the hub." readOnly>
          <span
            className={
              repo.remoteUrl ? "break-all font-mono text-xs" : "text-xs text-muted-foreground"
            }
            data-testid="settings-repo__url"
          >
            {repo.remoteUrl ?? "No remote. This repo lives on one worker only."}
          </span>
        </RepoRow>
        <RepoRow label="Default branch" description="New worktrees branch from it." readOnly>
          <span className="font-mono text-xs" data-testid="settings-repo__branch">
            {repo.defaultBranch}
          </span>
          <Hint>Read from origin/HEAD</Hint>
        </RepoRow>
      </RepoSection>

      <RepoSection
        title="Workers"
        description="Where this repo may run and where each worker keeps its clone. The primary worker holds the default-branch worktree."
        from="from Repos"
        testId="settings-repo__workers"
      >
        <RepoWorkers repo={repo} />
      </RepoSection>

      <RepoSection
        title="Agents"
        description="Which login each coding agent uses in this repo."
        from="from Agent logins"
      >
        <RepoLoginOverrides repoName={repo.name} />
      </RepoSection>

      <RepoSection
        title="Environment"
        description={
          <>
            What <span className="font-mono">.band/environment.json</span> in this repo asks for,
            checked against the workers.
          </>
        }
        from="from Environment"
      >
        <RepoEnvironmentDetails repoName={repo.name} />
      </RepoSection>

      <RepoSection
        title="Continuity"
        description="What happens when a worker goes offline."
        from="from Repos"
      >
        <CheckpointsSwitch repo={repo} />
        <AutoContinueSwitch repo={repo} />
      </RepoSection>

      <RepoSection
        title="Browser"
        description="The cookie profile new browser tabs in this repo open with."
        from="from Browser"
      >
        <RepoRow label="Default profile" description="Applies to every worktree of this repo.">
          <RepoBrowserProfileSelect repoName={repo.name} />
        </RepoRow>
      </RepoSection>

      <RepoSection
        title="MCP servers"
        description="Servers this repo's chats get. Servers are set up in MCP."
        from="view of MCP"
      >
        {admin ? (
          <RepoMcpServers repoName={repo.name} onOpenMcp={onOpenMcp} />
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            Listing MCP servers needs an admin token.
          </p>
        )}
      </RepoSection>

      <RepoSection
        title="Automation"
        description="Cronjobs in this repo's worktrees."
        from="view of Cronjobs"
      >
        <RepoCronjobs repo={repo} onOpenCronjobs={onOpenCronjobs} />
      </RepoSection>
    </div>
  );
}
