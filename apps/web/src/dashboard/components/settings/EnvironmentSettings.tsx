import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useProjects } from "../../hooks/use-projects";

type ProjectEnvironment = Awaited<ReturnType<typeof trpc.environment.forProject.query>>;

function Summary({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-xs">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-mono">{value}</dd>
    </div>
  );
}

type ImageStatus = Awaited<ReturnType<typeof trpc.environment.imageStatus.query>>;

/**
 * The project's environment image: the current one (what a runner boots), the
 * latest build with its status and log, and a button to build now. The status
 * refreshes every two seconds while a build runs.
 */
function EnvironmentImage({ projectName }: { projectName: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["environment.imageStatus", projectName];
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { data } = useQuery<ImageStatus>({
    queryKey,
    queryFn: () => trpc.environment.imageStatus.query({ projectName }),
    refetchInterval: (query) => (query.state.data?.latest?.status === "building" ? 2000 : false),
  });

  async function build() {
    setError(null);
    setNotice(null);
    setStarting(true);
    try {
      const started = await trpc.environment.build.mutate({ projectName });
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
  const building = latest?.status === "building";
  return (
    <div
      className="space-y-2"
      data-testid="settings__environment-image"
      data-status={latest?.status ?? "none"}
      data-current={data?.current?.image ?? ""}
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-medium">Image</h4>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={starting || building}
          onClick={build}
          data-testid="settings__environment-image-build"
        >
          {building ? "Building…" : "Build image"}
        </Button>
      </div>
      {notice ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="settings__environment-image-notice"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" data-testid="settings__environment-image-error">
          {error}
        </p>
      ) : null}
      <dl className="space-y-1">
        <Summary label="Current" value={data?.current?.image ?? "none (no build has finished)"} />
        <Summary
          label="Last build"
          value={latest ? `${latest.status}${latest.error ? `: ${latest.error}` : ""}` : "never"}
        />
      </dl>
      {latest?.log ? (
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px]"
          data-testid="settings__environment-image-log"
        >
          {latest.log}
        </pre>
      ) : null}
    </div>
  );
}

function ProjectEnvironmentDetails({ projectName }: { projectName: string }) {
  const { data, isLoading, error } = useQuery<ProjectEnvironment>({
    queryKey: ["environment.forProject", projectName],
    queryFn: () => trpc.environment.forProject.query({ projectName }),
  });

  if (isLoading) return <p className="px-4 py-3 text-xs text-muted-foreground">Loading…</p>;
  if (error || !data) {
    return <p className="px-4 py-3 text-xs text-destructive">Could not read the environment.</p>;
  }
  if (data.source === null) {
    return (
      <p
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid="settings__environment-none"
      >
        No .band/environment.json in this project.
      </p>
    );
  }

  const environment = data.environment;
  const build = environment?.build;
  return (
    <div className="space-y-3 px-4 py-3">
      <p className="break-all font-mono text-xs text-muted-foreground">{data.source}</p>

      {data.issues.length > 0 ? (
        <ul
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-testid="settings__environment-issues"
        >
          {data.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`} className="text-xs">
              {issue.path ? <span className="font-mono">{issue.path}</span> : null}
              {issue.path ? ": " : null}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="settings__environment-valid">
          Valid.
        </p>
      )}

      {environment ? (
        <dl className="space-y-1" data-testid="settings__environment-summary">
          <Summary label="Build" value={build?.devcontainer ?? build?.dockerfile ?? build?.image} />
          <Summary label="Install" value={environment.install} />
          <Summary label="Start" value={environment.start} />
          <Summary label="Teardown" value={environment.teardown} />
          <Summary label="Isolation" value={environment.isolation} />
          <Summary
            label="Terminals"
            value={environment.terminals?.map((t) => `${t.name}: ${t.command}`).join("\n")}
          />
          <Summary label="Secrets" value={environment.secrets?.join(", ")} />
          <Summary
            label="Services"
            value={
              environment.services
                ? Object.entries(environment.services)
                    .map(([name, image]) => `${name} (${image})`)
                    .join(", ")
                : undefined
            }
          />
          <Summary
            label="Requires"
            value={
              environment.requires
                ? Object.entries(environment.requires)
                    .map(([tool, range]) => `${tool} ${range}`)
                    .join(", ")
                : undefined
            }
          />
        </dl>
      ) : null}

      {environment?.build ? <EnvironmentImage projectName={projectName} /> : null}

      {data.hosts.length > 0 && environment?.requires ? (
        <div className="space-y-1">
          <h4 className="text-xs font-medium">Hosts</h4>
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.hosts.map((host) => (
              <li
                key={host.id}
                className="flex items-start justify-between gap-3 px-3 py-2 text-xs"
                data-testid="settings__environment-host"
                data-meets={host.meets}
              >
                <span className="min-w-0 truncate">
                  {host.name}
                  {host.status === "online" ? "" : ` (${host.status})`}
                </span>
                <span className={host.meets ? "text-muted-foreground" : "text-destructive"}>
                  {host.meets
                    ? "Meets requires"
                    : host.unmet
                        .map((u) => `${u.tool} ${u.range} (has ${u.found ?? "none"})`)
                        .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Rows for the Settings dialog's Environment section: one collapsed entry per
 * project that, when opened, shows the project's `.band/environment.json`
 * parsed, its validation problems, which hosts meet its `requires` and, when it
 * has a `build`, its image with a button to build it. The file is read-only.
 * Edit it in the repository, or check it with `band env validate`.
 */
export function EnvironmentSettings() {
  const { projects } = useProjects();
  const [open, setOpen] = useState<string>("");

  if (projects.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">No projects yet.</p>;
  }

  return (
    <Accordion type="single" collapsible value={open} onValueChange={setOpen}>
      {projects.map((project) => (
        <AccordionItem
          key={project.name}
          value={project.name}
          className="border-b-0"
          data-testid="settings__environment-project"
        >
          <AccordionTrigger
            className="px-4 py-3 hover:no-underline"
            data-testid={`settings__environment-trigger-${project.name}`}
          >
            <span className="min-w-0 truncate text-sm font-medium">{project.name}</span>
          </AccordionTrigger>
          <AccordionContent className="pb-0">
            {open === project.name ? (
              <ProjectEnvironmentDetails projectName={project.name} />
            ) : null}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
