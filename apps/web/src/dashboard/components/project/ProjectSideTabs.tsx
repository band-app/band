import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useCapabilities } from "../../context";
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

function CharterDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const charter = useQuery({
    queryKey: ["projects.charter", project.id],
    queryFn: () => trpc.projects.charter.query({ project: project.id }),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]" data-testid="project-page__charter">
        <DialogHeader>
          <DialogTitle>Coordinator charter</DialogTitle>
          <DialogDescription>
            What the coordinator is told about this project before the context preamble.
          </DialogDescription>
        </DialogHeader>
        {charter.error ? (
          <p role="alert" className="text-xs text-destructive">
            {errorText(charter.error)}
          </p>
        ) : charter.data ? (
          <pre
            className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap"
            data-testid="project-page__charter-text"
          >
            {charter.data.charter}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Repos --------------------------------------------------------------------------------------

// ---- Activity -----------------------------------------------------------------------------------

function ActivityTab({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const openWorktree = useOpenWorktree();
  const [charterOpen, setCharterOpen] = useState(false);
  return (
    <>
      <ProjectActivity
        project={project}
        canEdit={canEdit}
        onOpenWorktree={openWorktree}
        onOpenCharter={() => setCharterOpen(true)}
      />
      <CharterDialog project={project} open={charterOpen} onOpenChange={setCharterOpen} />
    </>
  );
}
