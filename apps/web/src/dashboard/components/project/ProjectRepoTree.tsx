import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useRepos } from "../../hooks/use-repos";
import { FileBrowser } from "../FileBrowser";
import { ProjectAddRepoDialog } from "../ProjectAddRepoDialog";
import { RepoAvatar } from "../RepoAvatar";
import { SettingsPage } from "../SettingsPage";
import { ErrorLine, errorText, PROJECTS_KEY, type ProjectList } from "./project-sections";

interface Checkout {
  repo: string;
  branch: string;
  status: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  error?: string;
}

function checkoutText(c: Checkout | undefined): string {
  if (!c) return "no checkout yet";
  if (c.error) return c.error;
  const parts: string[] = [];
  if (c.behind > 0) parts.push(`${c.behind} behind`);
  if (c.ahead > 0) parts.push(`${c.ahead} ahead`);
  if (c.dirty) parts.push("uncommitted changes");
  return parts.length > 0 ? parts.join(", ") : "up to date";
}

function HeaderButton({
  label,
  icon: Icon,
  onClick,
  testid,
  disabled,
}: {
  label: string;
  icon: React.FC<{ className?: string }>;
  onClick: () => void;
  testid: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          data-testid={testid}
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Repos tab of a project's view: a multi-root tree like the Explorer. Its header has Add repo,
 * Fetch and pull and Collapse. Each root is a repo of the project, labelled with the default
 * branch its checkout in the project folder (`repos/<repo>`) is on and how far that is from
 * origin, and holds that checkout's files. Those checkouts never sync between hosts.
 */
export function ProjectRepoTree({
  projectId,
  worktreeId,
  worktreePath,
  selectedFile,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
}: {
  projectId: string;
  worktreeId: string;
  worktreePath?: string;
  selectedFile?: string;
  onOpenFile: (path: string, pinned: boolean) => void;
  onPathRenamed?: (oldPath: string, newPath: string) => void;
  onPathDeleted?: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const { repos } = useRepos();
  const list = useQuery<ProjectList>({
    queryKey: PROJECTS_KEY,
    queryFn: () => trpc.projects.list.query(),
    refetchInterval: 4000,
  });
  // Changing a project needs an admin token, and so does `context.list`, so it doubles as the probe.
  const admin = useQuery({
    queryKey: ["projects.admin"],
    queryFn: () => trpc.context.list.query(),
    retry: false,
  });
  const canEdit = admin.isSuccess;
  const project = list.data?.projects.find((p) => p.id === projectId);
  const folderKey = ["projects.folder", projectId];
  const folder = useQuery({
    queryKey: folderKey,
    queryFn: () => trpc.projects.folder.query({ project: projectId }),
    refetchInterval: 5_000,
    enabled: project?.coordinator != null,
  });
  const checkouts = (folder.data?.folder?.checkouts ?? []) as Checkout[];
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [hostsOpen, setHostsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    } catch (err) {
      setError(errorText(err));
    }
  };
  const sync = async () => {
    setBusy(true);
    await run(() => trpc.projects.syncFolder.mutate({ project: projectId }));
    await queryClient.invalidateQueries({ queryKey: folderKey });
    setBusy(false);
  };
  const toggle = (repo: string) =>
    setCollapsed((c) => (c.includes(repo) ? c.filter((r) => r !== repo) : [...c, repo]));

  if (!project) return null;
  return (
    <div
      className="flex h-full flex-col"
      data-testid="project-page__repos"
      data-project={project.name}
      data-project-id={project.id}
    >
      <div className="group flex h-7 shrink-0 items-center gap-1 pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Repos
        </span>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {canEdit ? (
            <HeaderButton
              label="Add repo"
              icon={Plus}
              onClick={() => setAdding(true)}
              testid="projects__add-repo-open"
            />
          ) : null}
          {canEdit && project.coordinator && project.repos.length > 0 ? (
            <HeaderButton
              label="Fetch and pull the default branches"
              icon={RefreshCw}
              onClick={() => void sync()}
              disabled={busy}
              testid="projects__folder-sync"
            />
          ) : null}
          <HeaderButton
            label="Collapse all repos"
            icon={ChevronsDownUp}
            onClick={() => setCollapsed(project.repos.map((r) => r.repo))}
            testid="project-repos__collapse-all"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {project.repos.length === 0 ? (
          <p
            className="px-3 py-2 text-xs text-muted-foreground"
            data-testid="project-page__no-repos"
          >
            No repos yet. Add a folder from a worker or a remote URL. Agents of this project work
            only in its repos.
          </p>
        ) : (
          <ul data-testid={project.coordinator ? "projects__folder" : undefined}>
            {project.repos.map((r) => {
              const info = repos.find((x) => x.name === r.repo);
              const checkout = checkouts.find((c) => c.repo === r.repo);
              const open = !collapsed.includes(r.repo);
              const remote = info?.remoteUrl ?? "No remote: this repo lives on one host only.";
              return (
                <li
                  key={r.repo}
                  data-testid="projects__repo"
                  data-repo={r.repo}
                  data-role={r.role ?? ""}
                >
                  <div className="group flex h-6 items-center gap-1 pr-2 pl-1.5 hover:bg-accent/50">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      aria-expanded={open}
                      onClick={() => toggle(r.repo)}
                      title={remote}
                      data-testid="projects__repo-url"
                      data-url={info?.remoteUrl ?? ""}
                    >
                      {open ? (
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <RepoAvatar
                        avatar={info?.avatar}
                        className="size-4"
                        fallback={
                          open ? (
                            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <Folder className="size-4 shrink-0 text-muted-foreground" />
                          )
                        }
                      />
                      <span className="truncate text-[13px] font-semibold">{r.repo}</span>
                      {r.role ? (
                        <span className="truncate text-xs text-muted-foreground">{r.role}</span>
                      ) : null}
                    </button>
                    <span
                      className={cn(
                        "shrink-0 truncate text-xs text-muted-foreground",
                        checkout?.error && "text-destructive",
                      )}
                      title={checkoutText(checkout)}
                    >
                      <span className="font-mono" data-testid="projects__repo-branch">
                        {info?.defaultBranch ?? checkout?.branch ?? ""}
                      </span>
                      {project.coordinator ? (
                        <span
                          data-testid="projects__checkout"
                          data-repo={r.repo}
                          data-status={checkout?.status ?? ""}
                          data-dirty={checkout?.dirty ? "true" : "false"}
                        >
                          {checkout && !checkout.error && checkoutText(checkout) === "up to date"
                            ? ""
                            : ` · ${checkoutText(checkout)}`}
                        </span>
                      ) : null}
                    </span>
                    {canEdit ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Remove ${r.repo}`}
                            data-testid="projects__repo-remove"
                            data-repo={r.repo}
                            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                            onClick={() =>
                              run(() =>
                                trpc.projects.removeRepo.mutate({
                                  project: projectId,
                                  repo: r.repo,
                                }),
                              )
                            }
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          Remove {r.repo} from the project
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                  {open && checkout && !checkout.error ? (
                    <div className="pl-3">
                      <FileBrowser
                        worktreeId={worktreeId}
                        worktreePath={worktreePath}
                        rootPath={`repos/${r.repo}`}
                        inline
                        onOpenFile={(p) => onOpenFile(p, false)}
                        onOpenFilePinned={(p) => onOpenFile(p, true)}
                        selectedFile={selectedFile}
                        onPathRenamed={onPathRenamed}
                        onPathDeleted={onPathDeleted}
                        compact
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="px-3">
          <ErrorLine message={error} />
        </div>
      </div>
      <ProjectAddRepoDialog
        open={adding}
        onOpenChange={setAdding}
        projectId={projectId}
        onOpenHosts={() => {
          setAdding(false);
          setHostsOpen(true);
        }}
        onAdded={() =>
          void run(async () => {
            // The first repo of a project is what lets the coordinator start.
            if (!project.coordinator) {
              await trpc.projects.startCoordinator.mutate({ project: projectId });
            }
          })
        }
      />
      {hostsOpen ? <SettingsPage open onOpenChange={setHostsOpen} initialSection="hosts" /> : null}
    </div>
  );
}
