import { toWorktreeId } from "@band-app/shared/worktree-id";
import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useUpdateRepoLabel } from "../../hooks/use-repo-mutations";
import { useRepos } from "../../hooks/use-repos";
import { useSettingsQuery } from "../../hooks/use-settings-query";
import { useHostsList } from "../../hooks/use-update-status";
import type { RepoInfo } from "../../types";
import { RepoLoginOverrides } from "./AgentLoginsSettings";
import { RepoBrowserProfileSelect } from "./BrowserProfilesSettings";
import { useIsAdmin } from "./DevicesSettings";
import { AutoContinueSwitch, CheckpointsSwitch, RepoHostsEditor } from "./RepoControls";
import { RepoEnvironmentDetails } from "./RepoEnvironment";
import { repoWorktreeCount } from "./ReposOverview";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageContext, SettingsSection } from "./SettingsSection";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const SECTIONS = [
  { id: "general", title: "General" },
  { id: "workers", title: "Workers" },
  { id: "agents", title: "Agents" },
  { id: "environment", title: "Environment" },
  { id: "continuity", title: "Continuity" },
  { id: "browser", title: "Browser" },
  { id: "mcp", title: "MCP servers" },
  { id: "automation", title: "Automation" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const sectionDomId = (id: SectionId) => `settings-repo-section-${id}`;

/** The repo's one label, picked from the labels made in Settings > Labels. */
function RepoLabelSelect({ repo }: { repo: RepoInfo }) {
  const { settings } = useSettingsQuery();
  const updateLabel = useUpdateRepoLabel();
  const labels = settings.labels ?? [];
  const id = `settings-repo-${repo.name}-label`;
  return (
    <SettingsRow
      htmlFor={id}
      label="Label"
      description="One per repo. Filters and groups repos in the sidebar. Labels are made in Labels."
    >
      <select
        id={id}
        aria-label={`Label for ${repo.name}`}
        data-testid="settings-repo__label"
        value={repo.label ?? ""}
        disabled={updateLabel.isPending}
        onChange={(e) => updateLabel.mutate({ name: repo.name, label: e.target.value || null })}
        className="h-8 min-w-40 rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="">No label</option>
        {labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </SettingsRow>
  );
}

/** Each worker that holds the repo or one of its worktrees: its folder and its worktree count. */
function RepoWorkerList({ repo }: { repo: RepoInfo }) {
  const hosts = useHostsList();
  const counts = new Map<string, number>();
  for (const w of repo.worktrees) {
    if (w.path === repo.path) continue;
    const host = w.hostId ?? "local";
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const clones = repo.clones ?? [];
  const ids = [...new Set([...clones.map((c) => c.hostId), ...counts.keys()])];
  if (ids.length === 0) {
    return (
      <p
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid="settings-repo__clones-none"
      >
        Not cloned anywhere yet. The first worktree on a worker clones it.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border" data-testid="settings-repo__clones">
      {ids.map((hostId) => {
        const host = hosts.data?.find((h) => h.id === hostId);
        const path = clones.find((c) => c.hostId === hostId)?.path;
        const count = counts.get(hostId) ?? 0;
        return (
          <li
            key={hostId}
            className="flex items-center justify-between gap-3 px-4 py-2.5"
            data-testid="settings-repo__clone"
            data-host={hostId}
            data-worktrees={count}
          >
            <div className="min-w-0">
              <div className="text-sm">
                {host?.name ?? hostId}
                {host ? (
                  <span className="ml-2 text-xs text-muted-foreground">{host.status}</span>
                ) : null}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {path ?? "no clone recorded"}
              </div>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {count} worktree{count === 1 ? "" : "s"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

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
        No MCP server reaches this repo's chats. Servers are set up in MCP.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {reached.map((server) => (
        <li
          key={server.id}
          className="flex items-center justify-between gap-3 px-4 py-2.5"
          data-testid="settings-repo__mcp-server"
          data-server={server.name}
        >
          <div className="min-w-0">
            <div className="truncate text-sm">{server.name}</div>
            <div className="text-xs text-muted-foreground">
              {server.scopeRepos ? "Scoped to this repo" : "All repos"}
              {server.scopeHosts ? ", some workers only" : ""}
            </div>
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
      ))}
    </ul>
  );
}

/** The cronjobs of this repo's worktrees. */
function RepoCronjobs({ repo, onOpenCronjobs }: { repo: RepoInfo; onOpenCronjobs?: () => void }) {
  const jobs = useQuery({
    queryKey: ["cronjobs.list"],
    queryFn: () => trpc.cronjobs.list.query(),
  });
  const worktreeIds = new Set<string>(
    repo.worktrees.map((w) => toWorktreeId(repo.name, w.name, w.hostId ?? "local")),
  );
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
  const mine = (jobs.data?.jobs ?? []).filter((j) => j.worktreeId && worktreeIds.has(j.worktreeId));
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
    <ul className="divide-y divide-border">
      {mine.map((job) => (
        <li
          key={`${job.fileKey}:${job.id}`}
          className="flex items-center justify-between gap-3 px-4 py-2.5"
          data-testid="settings-repo__cronjob"
          data-cronjob={job.id}
        >
          <div className="min-w-0">
            <div className="truncate text-sm">{job.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              <span className="font-mono">{job.cronExpression}</span> · {job.worktreeId}
              {job.enabled ? "" : " · disabled"}
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

/** Remove, at the top of the page. Disabled while the repo has worktrees; asks before it removes. */
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
        <Button
          size="sm"
          variant="outline"
          aria-label={`Remove ${repo.name}`}
          data-testid="settings-repo__remove"
          disabled={worktrees > 0}
          onClick={() => setConfirming(true)}
        >
          Remove repo…
        </Button>
      )}
      {worktrees > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="settings-repo__in-use">
          Remove its {worktrees} worktree{worktrees === 1 ? "" : "s"} first.
        </p>
      ) : null}
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
 * it. Each control saves through the procedure it used before this page existed.
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

  const workerName = (id: string) => hosts.data?.find((h) => h.id === id)?.name ?? id;
  const scrollTo = (id: SectionId) =>
    document.getElementById(sectionDomId(id))?.scrollIntoView({ block: "start" });

  return (
    <SettingsPageContext.Provider value={false}>
      <div className="space-y-6" data-testid="settings-repo" data-repo={repo.name}>
        <header className="space-y-3">
          {crumbs}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <h1 className="text-xl font-semibold" data-testid="settings-repo__title">
                {repo.name}
              </h1>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {repo.remoteUrl ?? "No remote"}
              </p>
            </div>
            <RemoveRepo repo={repo} onRemoved={onBack} />
          </div>
          <div className="flex flex-wrap gap-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="rounded-full bg-muted px-2.5 py-0.5 text-xs hover:bg-accent"
                onClick={() => scrollTo(s.id)}
              >
                {s.title}
              </button>
            ))}
          </div>
          {repo.allowedHostIds ? (
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
              data-testid="settings-repo__limited-note"
            >
              This repo is limited to{" "}
              {repo.allowedHostIds.map(workerName).join(", ") || "no worker"}. Checkpoints are off
              by default for a limited repo, and it continues only on another allowed worker.
            </p>
          ) : null}
        </header>

        <div id={sectionDomId("general")}>
          <SettingsSection title="General">
            <RepoLabelSelect repo={repo} />
            <SettingsRow label="Remote" description="The repo's identity on the hub.">
              <span
                className={
                  repo.remoteUrl
                    ? "block max-w-80 break-all text-right font-mono text-xs text-muted-foreground"
                    : "block max-w-80 text-right text-xs text-muted-foreground"
                }
                data-testid="settings-repo__url"
              >
                {repo.remoteUrl ?? "No remote. This repo lives on one worker only."}
              </span>
            </SettingsRow>
            <SettingsRow label="Default branch" description="New worktrees branch from it.">
              <span className="font-mono text-xs" data-testid="settings-repo__branch">
                {repo.defaultBranch}
              </span>
            </SettingsRow>
          </SettingsSection>
        </div>

        <div id={sectionDomId("workers")}>
          <SettingsSection
            title="Workers"
            description="Where this repo may run, and where each worker keeps its clone."
          >
            <RepoHostsEditor repo={repo} />
            <RepoWorkerList repo={repo} />
          </SettingsSection>
        </div>

        <div id={sectionDomId("agents")}>
          <SettingsSection
            title="Agents"
            description="Which login each coding agent uses in this repo."
          >
            <RepoLoginOverrides repoName={repo.name} />
          </SettingsSection>
        </div>

        <div id={sectionDomId("environment")}>
          <SettingsSection
            title="Environment"
            description="What .band/environment.json in this repo asks for, checked against the workers."
          >
            <RepoEnvironmentDetails repoName={repo.name} />
          </SettingsSection>
        </div>

        <div id={sectionDomId("continuity")}>
          <SettingsSection
            title="Continuity"
            description="What happens when a worker goes offline."
          >
            <CheckpointsSwitch repo={repo} />
            <AutoContinueSwitch repo={repo} />
          </SettingsSection>
        </div>

        <div id={sectionDomId("browser")}>
          <SettingsSection title="Browser">
            <SettingsRow
              variant="responsive"
              label="Default profile"
              description="New browser tabs in any worktree of this repo open with it."
            >
              <RepoBrowserProfileSelect repoName={repo.name} />
            </SettingsRow>
          </SettingsSection>
        </div>

        <div id={sectionDomId("mcp")}>
          <SettingsSection
            title="MCP servers"
            description="Servers this repo's chats get. Servers are set up in MCP."
          >
            {admin ? (
              <RepoMcpServers repoName={repo.name} onOpenMcp={onOpenMcp} />
            ) : (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                Listing MCP servers needs an admin token.
              </p>
            )}
          </SettingsSection>
        </div>

        <div id={sectionDomId("automation")}>
          <SettingsSection title="Automation" description="Cronjobs in this repo's worktrees.">
            <RepoCronjobs repo={repo} onOpenCronjobs={onOpenCronjobs} />
          </SettingsSection>
        </div>
      </div>
    </SettingsPageContext.Provider>
  );
}
