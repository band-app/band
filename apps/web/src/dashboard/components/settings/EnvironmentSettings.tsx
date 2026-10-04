import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
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
 * parsed, its validation problems and which hosts meet its `requires`. It is
 * read-only. Edit the file in the repository, or check it with
 * `band env validate`.
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
