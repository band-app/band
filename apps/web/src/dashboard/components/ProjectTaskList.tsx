import { projectScopeId } from "@band-app/shared/scope-id";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FolderKanban,
  MoreVertical,
  Plus,
  Settings,
} from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { projectHref, rememberProjects } from "../../lib/project-slugs";
import { trpc } from "../../lib/trpc-client";
import { useCapabilities } from "../context";
import { usePinnedWorktrees } from "../hooks/use-pinned-worktrees";
import { useRemoveWorktree } from "../hooks/use-repo-mutations";
import { useRepos } from "../hooks/use-repos";
import { useDashboardStore } from "../stores/index";
import type { DeleteDialogInfo } from "../types";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { NewProjectWorktreeDialog, type NewWorktreeProject } from "./NewProjectWorktreeDialog";
import { CreateProjectFlow } from "./project/CreateProjectFlow";
import { projectTitle } from "./project/project-sections";
import { SettingsPage } from "./SettingsPage";
import { WorktreeCard } from "./WorktreeCard";

type ProjectList = Awaited<ReturnType<typeof trpc.projects.list.query>>;
type Project = ProjectList["projects"][number];

const POLL_MS = 4000;
const COLLAPSED_KEY = "band.sidebar-projects-collapsed";

function readCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The sidebar's projects. A project's name opens its folder in the worktree view, with the
 * coordinator's chat, and it expands to the worktrees made in it, each opening the same worktree
 * view as from the repos list. New project is the "+" in the header above (`NewProjectButton`).
 */
export function ProjectTaskList() {
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query(),
    refetchInterval: POLL_MS,
  });
  const list = projects.data?.projects ?? [];
  // The URL names a project by its name, so keep the name to id map current.
  useEffect(() => {
    if (projects.data) rememberProjects(projects.data.projects);
  }, [projects.data]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  return (
    <section className="px-2 pt-1 pb-2" data-testid="project-tasks" aria-label="Projects">
      {list.map((p) => (
        <ProjectBlock
          key={p.id}
          project={p}
          expanded={!collapsed.includes(p.id)}
          onToggle={() => toggle(p.id)}
        />
      ))}
    </section>
  );
}

/** The "+" in the sidebar's Projects header: opens the New project flow. */
export function NewProjectButton({ onOpenHosts }: { onOpenHosts?: () => void }) {
  const capabilities = useCapabilities();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        aria-label="New project"
        title="New project"
        data-testid="projects-header__new-project"
        onClick={() => setCreating(true)}
      >
        <Plus className="size-4" />
      </Button>
      <CreateProjectFlow
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => capabilities.navigate?.(projectHref(id))}
        onOpenHosts={onOpenHosts}
      />
    </>
  );
}

function ProjectBlock({
  project,
  expanded,
  onToggle,
}: {
  project: Project;
  expanded: boolean;
  onToggle: () => void;
}) {
  const capabilities = useCapabilities();
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogInfo | null>(null);
  const removeWorktree = useRemoveWorktree();
  const { toggle: togglePinned } = usePinnedWorktrees();
  const activeWorktreeId = useDashboardStore((s) => s.activeWorktreeId);
  const selected = activeWorktreeId === projectScopeId(project.id);
  const forDialog: NewWorktreeProject = {
    id: project.id,
    name: project.name,
    repos: project.repos.map((r) => ({ repo: r.repo, role: r.role ?? null })),
  };
  const openWorktree = (worktreeId: string) => {
    const href = capabilities.getWorktreeHref?.(worktreeId);
    if (href) capabilities.navigate?.(href);
  };
  // The coordinator has no row of its own: the project's folder view shows its chat.
  const openProject = () => capabilities.navigate?.(projectHref(project.id));
  return (
    <div
      className="mt-0.5"
      data-testid="project-tasks__project"
      data-project={project.name}
      data-expanded={expanded}
    >
      <div
        className={cn(
          "group flex items-center gap-0.5 rounded-md hover:bg-muted/60",
          selected && "bg-primary/15 hover:bg-primary/15",
        )}
        data-selected={selected}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={
            expanded ? `Collapse ${projectTitle(project)}` : `Expand ${projectTitle(project)}`
          }
          aria-expanded={expanded}
          data-testid="project-tasks__toggle"
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-testid="project-tasks__project-open"
          aria-current={selected ? "page" : undefined}
          onClick={openProject}
        >
          <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate" data-testid="project-tasks__project-name">
            {projectTitle(project)}
          </span>
        </button>
        {/* Non-modal: a modal menu sets `pointer-events: none` on the body, and the Settings dialog
            opened from it restores that value on close, which leaves the page unclickable. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label={`More actions for ${projectTitle(project)}`}
              data-testid="project-tasks__menu"
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-testid="project-tasks__menu-settings"
              onSelect={() => setSettingsOpen(true)}
            >
              <Settings className="size-4" />
              Settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`New worktree in ${projectTitle(project)}`}
          data-testid="project-tasks__new-worktree"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-0.5 pt-0.5 pl-4">
          {project.worktrees.map((w) => (
            <ProjectWorktreeCard
              key={w.worktreeId}
              entry={w}
              onShowDeleteDialog={setDeleteDialog}
              onTogglePinned={togglePinned}
            />
          ))}
        </div>
      ) : null}
      {settingsOpen ? (
        <SettingsPage
          open
          onOpenChange={setSettingsOpen}
          initialSection="projects"
          initialProject={project.id}
        />
      ) : null}
      <DeleteWorktreeDialog
        open={deleteDialog !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDialog(null);
        }}
        onConfirm={() => {
          if (deleteDialog) {
            removeWorktree.mutate({ repo: deleteDialog.repoName, name: deleteDialog.name });
            setDeleteDialog(null);
          }
        }}
        branchName={deleteDialog?.name ?? ""}
        isUnmerged={deleteDialog?.isUnmerged ?? false}
        isDirty={deleteDialog?.isDirty ?? false}
        hasUnpushedCommits={deleteDialog?.hasUnpushedCommits ?? false}
      />
      <NewProjectWorktreeDialog
        project={forDialog}
        open={creating}
        onOpenChange={setCreating}
        onCreated={openWorktree}
      />
    </div>
  );
}

/**
 * A project's worktree in the sidebar: the same card as a pinned worktree (branch, repo, agent and
 * git status, PR badge, context menu), fed from the same stores, so both always show the same.
 */
function ProjectWorktreeCard({
  entry,
  onShowDeleteDialog,
  onTogglePinned,
}: {
  entry: Project["worktrees"][number];
  onShowDeleteDialog: (info: DeleteDialogInfo) => void;
  onTogglePinned: ComponentProps<typeof WorktreeCard>["onTogglePinned"];
}) {
  const { worktreeId, repo, name } = entry;
  const { repos } = useRepos();
  const status = useDashboardStore((s) => s.statuses.get(worktreeId));
  const branchStatus = useDashboardStore((s) => s.branchStatuses.get(worktreeId));
  const setupStatus = useDashboardStore((s) => s.setupStatuses.get(worktreeId));
  const repoInfo = repos.find((r) => r.name === repo);
  // The repos list can trail the projects list by a poll; until it has the worktree, the
  // project's own row stands in.
  const worktree = repoInfo?.worktrees.find((w) => w.name === name) ?? {
    name,
    branch: entry.branch,
    path: entry.path,
    pinned: false,
  };
  return (
    <div data-testid="project-tasks__worktree" data-worktree={worktreeId}>
      <WorktreeCard
        worktree={worktree}
        repoName={repo}
        defaultBranch={repoInfo?.defaultBranch ?? "main"}
        repoKind={repoInfo?.kind}
        status={status}
        branchStatus={branchStatus}
        setupStatus={setupStatus}
        onShowDeleteDialog={onShowDeleteDialog}
        showRepoName
        onTogglePinned={onTogglePinned}
      />
    </div>
  );
}
