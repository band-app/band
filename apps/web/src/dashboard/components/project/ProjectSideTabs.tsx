import { projectScopeId } from "@band-app/shared/scope-id";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useCapabilities } from "../../context";
import { useWorktreePath } from "../../hooks/use-worktree-path";
import { SettingsPage } from "../SettingsPage";
import { ProjectActivity } from "./ProjectActivity";
import { errorText, PROJECTS_KEY, type Project, type ProjectList } from "./project-sections";

export type ProjectSideTabId = "activity" | "repos";

/**
 * The side tabs a project's folder view adds to the right panel, after Explorer. The folder's
 * files, its terminals and the coordinator's chat are the worktree view itself, and the project's
 * worktrees and New worktree are on its sidebar row.
 */
export const PROJECT_SIDE_TABS: Array<{ id: ProjectSideTabId; label: string }> = [
  { id: "repos", label: "Repos" },
  { id: "activity", label: "Activity" },
];

const POLL_MS = 4000;

/** One project side tab's content, for the project with this id. */
export function ProjectSideTab({ projectId, tab }: { projectId: string; tab: ProjectSideTabId }) {
  const list = useQuery<ProjectList>({
    queryKey: PROJECTS_KEY,
    queryFn: () => trpc.projects.list.query(),
    refetchInterval: POLL_MS,
  });
  // Changing a project needs an admin token, and so does `context.list`, so it doubles as the probe.
  const admin = useQuery({
    queryKey: ["projects.admin"],
    queryFn: () => trpc.context.list.query(),
    retry: false,
  });
  const canEdit = admin.isSuccess;
  const [hostsOpen, setHostsOpen] = useState(false);
  const project = list.data?.projects.find((p) => p.id === projectId);

  let body: ReactNode;
  if (list.error && !list.data) {
    body = (
      <p className="text-xs text-destructive" role="alert">
        {errorText(list.error)}
      </p>
    );
  } else if (!list.data) {
    body = <p className="text-xs text-muted-foreground">Loading project…</p>;
  } else if (!project) {
    body = (
      <p className="text-xs text-muted-foreground" data-testid="project-page__missing">
        This project was deleted.
      </p>
    );
  } else {
    body = <ActivityTab project={project} canEdit={canEdit} />;
  }

  return (
    <div
      className="h-full overflow-y-auto"
      data-testid={`project-page__${tab}`}
      data-project={project?.name}
      data-project-id={project?.id}
    >
      <div className="space-y-5 p-3">{body}</div>
      {hostsOpen ? <SettingsPage open onOpenChange={setHostsOpen} initialSection="hosts" /> : null}
    </div>
  );
}

function useOpenWorktree() {
  const capabilities = useCapabilities();
  return (worktreeId: string) => {
    const href = capabilities.getWorktreeHref?.(worktreeId);
    if (href) capabilities.navigate?.(href);
  };
}

// ---- Repos --------------------------------------------------------------------------------------

// ---- Activity -----------------------------------------------------------------------------------

function ActivityTab({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const openWorktree = useOpenWorktree();
  const folder = useWorktreePath(projectScopeId(project.id));
  return (
    <ProjectActivity
      project={project}
      canEdit={canEdit}
      onOpenWorktree={openWorktree}
      onOpenInstructions={() => {
        // The same window event a file link in a chat fires, scoped to the project's folder view.
        if (folder) {
          window.dispatchEvent(
            new CustomEvent("band:open-file", {
              detail: { filename: `${folder}/AGENTS.md`, worktreeId: projectScopeId(project.id) },
            }),
          );
        }
      }}
    />
  );
}
