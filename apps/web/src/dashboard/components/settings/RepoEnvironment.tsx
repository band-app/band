import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useHostsList } from "../../hooks/use-update-status";
import { Chip, Hint, RepoRow } from "./repo-page-ui";

type RepoEnvironment = Awaited<ReturnType<typeof trpc.environment.forRepo.query>>;
type Environment = NonNullable<RepoEnvironment["environment"]>;
type ImageStatus = Awaited<ReturnType<typeof trpc.environment.imageStatus.query>>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "just now", "5 minutes ago", "3 hours ago" or "2 days ago". */
function ago(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

/** What the file asks for in one line, such as "install, start, 2 terminals, requires node >=24". */
function summaryOf(environment: Environment): string {
  const parts: string[] = [];
  const build = environment.build;
  if (build?.devcontainer) parts.push("devcontainer");
  else if (build?.dockerfile) parts.push("Dockerfile");
  else if (build?.image) parts.push(`image ${build.image}`);
  if (environment.install) parts.push("install");
  if (environment.start) parts.push("start");
  if (environment.teardown) parts.push("teardown");
  if (environment.terminals?.length) parts.push(plural(environment.terminals.length, "terminal"));
  const services = Object.keys(environment.services ?? {}).length;
  if (services) parts.push(plural(services, "service"));
  if (environment.secrets?.length) parts.push(plural(environment.secrets.length, "secret"));
  if (environment.isolation) parts.push(`${environment.isolation} isolation`);
  const requires = Object.entries(environment.requires ?? {})
    .map(([tool, range]) => `${tool} ${range}`)
    .join(", ");
  if (requires) parts.push(`requires ${requires}`);
  return parts.join(", ") || "nothing";
}

/** The file's commands in full, shown as the summary's tooltip. */
function detailsOf(environment: Environment): string {
  return [
    environment.install ? `install: ${environment.install}` : "",
    environment.start ? `start: ${environment.start}` : "",
    environment.teardown ? `teardown: ${environment.teardown}` : "",
    ...(environment.terminals ?? []).map((t) => `${t.name}: ${t.command}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The repo's environment image: the current one (what a runner boots), the
 * latest build with its status and log, and a button to build now. The status
 * refreshes every two seconds while a build runs.
 */
function EnvironmentImage({ repoName }: { repoName: string }) {
  const queryClient = useQueryClient();
  const hosts = useHostsList();
  const hostName = (id: string) => hosts.data?.find((h) => h.id === id)?.name;
  const queryKey = ["environment.imageStatus", repoName];
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { data } = useQuery<ImageStatus>({
    queryKey,
    queryFn: () => trpc.environment.imageStatus.query({ repoName }),
    refetchInterval: (query) => (query.state.data?.latest?.status === "building" ? 2000 : false),
  });

  async function build() {
    setError(null);
    setNotice(null);
    setStarting(true);
    try {
      const started = await trpc.environment.build.mutate({ repoName });
      if (started.cacheHit) setNotice("Cache hit: the image is already built.");
      else setNotice(null);
      await queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const latest = data?.latest ?? null;
  const current = data?.current ?? null;
  const building = latest?.status === "building";
  const builtOn = current ? (hostName(current.hostId) ?? current.hostId) : null;
  return (
    <RepoRow
      label="Image"
      description="What a runner boots for this repo."
      testId="settings-repo__environment-image"
    >
      <span
        className="contents"
        data-testid="settings-repo__environment-image-state"
        data-status={latest?.status ?? "none"}
        data-current={current?.image ?? ""}
      >
        <Hint>
          {building
            ? "Building…"
            : current
              ? `Current: built ${ago(current.endedAt ?? current.startedAt)} on ${builtOn}`
              : "No image built yet"}
        </Hint>
        {latest?.status === "failed" ? <Chip tone="warn">last build failed</Chip> : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={starting || building}
          onClick={build}
          data-testid="settings-repo__environment-image-build"
        >
          Build now
        </Button>
      </span>
      {notice ? (
        <p
          className="w-full text-xs text-muted-foreground"
          data-testid="settings-repo__environment-image-notice"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          className="w-full text-xs text-destructive"
          data-testid="settings-repo__environment-image-error"
        >
          {error}
        </p>
      ) : null}
      {latest?.log ? (
        <details className="w-full">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Log of the last build{latest.error ? `: ${latest.error}` : ""}
          </summary>
          <pre
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px]"
            data-testid="settings-repo__environment-image-log"
          >
            {latest.log}
          </pre>
        </details>
      ) : null}
    </RepoRow>
  );
}

/**
 * A repo's `.band/environment.json` on its repo page: the file parsed, its validation problems,
 * which workers meet its `requires` and, when it has a `build`, its image with a button to build
 * it. The file is read-only. Edit it in the repository, or check it with `band env validate`.
 */
export function RepoEnvironmentDetails({ repoName }: { repoName: string }) {
  const { data, isLoading, error } = useQuery<RepoEnvironment>({
    queryKey: ["environment.forRepo", repoName],
    queryFn: () => trpc.environment.forRepo.query({ repoName }),
  });

  if (isLoading) return <p className="px-4 py-3 text-xs text-muted-foreground">Loading…</p>;
  if (error || !data) {
    return <p className="px-4 py-3 text-xs text-destructive">Could not read the environment.</p>;
  }
  if (data.source === null) {
    return (
      <RepoRow label="File" description=".band/environment.json" readOnly>
        <Hint testId="settings-repo__environment-none">
          No .band/environment.json in this repo.
        </Hint>
      </RepoRow>
    );
  }

  const environment = data.environment;
  return (
    <>
      <RepoRow
        label="File"
        description={<span className="break-all font-mono">{data.source}</span>}
        readOnly
      >
        {data.issues.length > 0 ? (
          <>
            <Chip tone="warn">{plural(data.issues.length, "problem")}</Chip>
            <ul className="w-full space-y-0.5" data-testid="settings-repo__environment-issues">
              {data.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`} className="text-xs">
                  {issue.path ? <span className="font-mono">{issue.path}</span> : null}
                  {issue.path ? ": " : null}
                  {issue.message}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Chip tone="ok" testId="settings-repo__environment-valid">
            valid
          </Chip>
        )}
        {environment ? (
          <span title={detailsOf(environment)}>
            <Hint testId="settings-repo__environment-summary">{summaryOf(environment)}</Hint>
          </span>
        ) : null}
      </RepoRow>

      {environment?.requires && data.hosts.length > 0 ? (
        <RepoRow label="Workers that satisfy it" description="From each worker's tools.">
          {data.hosts.map((host) => (
            <span
              key={host.id}
              data-testid="settings-repo__environment-host"
              data-meets={host.meets}
            >
              <Chip tone={host.meets ? "ok" : "warn"}>
                {host.name}
                {host.status === "online" ? "" : ` (${host.status})`}
                {host.meets
                  ? ""
                  : `: ${host.unmet
                      .map((u) => `${u.tool} ${u.range} (has ${u.found ?? "none"})`)
                      .join(", ")}`}
              </Chip>
            </span>
          ))}
        </RepoRow>
      ) : null}

      {environment?.build ? <EnvironmentImage repoName={repoName} /> : null}
    </>
  );
}
