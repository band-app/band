import { projectScopeId } from "@band-app/shared/scope-id";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { projectIdForSlug, rememberProjects, useProjectSlugs } from "../lib/project-slugs";
import { trpc } from "../lib/trpc-client";
import { useWorktreeRoute } from "../lib/use-worktree-route";

// A project's view: the worktree view of its folder (`project:<id>`), at `/project/<name>`.
// `AppShell` draws it like any worktree from the URL; this route does what opening a worktree
// does, puts the name in the URL when a link named the id, and says so for an unknown project.
export const Route = createFileRoute("/project/$projectId")({
  component: ProjectRoute,
});

function ProjectRoute() {
  const { projectId: param } = Route.useParams();
  const slug = decodeURIComponent(param);
  useProjectSlugs();
  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query(),
  });
  useEffect(() => {
    if (projects.data) rememberProjects(projects.data.projects);
  }, [projects.data]);
  const found = projects.data?.projects.find((p) => p.name === slug || p.id === slug);
  const id = found?.id ?? projectIdForSlug(slug);
  useWorktreeRoute(id ? projectScopeId(id) : null);

  if (found && found.name !== slug) {
    return <Navigate to="/project/$projectId" params={{ projectId: found.name }} replace />;
  }
  if (!found && projects.data) {
    return (
      <p className="p-6 text-sm text-muted-foreground" data-testid="project-route__missing">
        No project "{slug}".
      </p>
    );
  }
  return null;
}
