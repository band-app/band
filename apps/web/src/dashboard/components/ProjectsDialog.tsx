import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useRepos } from "../hooks/use-repos";

type ProjectList = Awaited<ReturnType<typeof trpc.projects.list.query>>;
type Project = ProjectList["projects"][number];

const PROJECTS_KEY = ["projects.list"] as const;
const DEFAULT_MODEL = "opus";
const MODELS = ["opus", "sonnet", "haiku"];

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const splitLabels = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter(Boolean);

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" data-testid="projects__error" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function ModelSelect({
  value,
  onChange,
  disabled,
  testId = "projects__model-select",
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const options = MODELS.includes(value) ? MODELS : [value, ...MODELS];
  return (
    <select
      aria-label="Coordinator model"
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border bg-background px-2 text-sm"
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {m === DEFAULT_MODEL ? "opus (default)" : m}
        </option>
      ))}
    </select>
  );
}

type ContextMode = "new" | "existing" | "remote";

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
}) {
  const queryClient = useQueryClient();
  const { repos } = useRepos();
  const contexts = useQuery({
    queryKey: ["context.list"],
    queryFn: () => trpc.context.list.query(),
    enabled: open,
  });
  const projects = useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => trpc.projects.list.query(),
    enabled: open,
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [mode, setMode] = useState<ContextMode>("new");
  const [existing, setExisting] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [labels, setLabels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const owned = new Set((projects.data?.projects ?? []).map((p) => p.contextName));
  const free = (contexts.data?.contexts ?? []).filter(
    (c) => c.kind === "project" && !owned.has(c.name),
  );

  const toggle = (repo: string) =>
    setPicked((cur) => (cur.includes(repo) ? cur.filter((r) => r !== repo) : [...cur, repo]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { project } = await trpc.projects.create.mutate({
        name: name.trim(),
        description: description.trim() || undefined,
        repos: picked.map((repo) => ({ repo, role: roles[repo]?.trim() || null })),
        contextName: mode === "existing" ? existing : undefined,
        remoteUrl: mode === "remote" ? remoteUrl.trim() : undefined,
        coordinatorModel: model,
        labels: splitLabels(labels),
      });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      await queryClient.invalidateQueries({ queryKey: ["context.list"] });
      setName("");
      setDescription("");
      setPicked([]);
      setRoles({});
      setLabels("");
      setRemoteUrl("");
      setMode("new");
      onOpenChange(false);
      onCreated(project);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ready =
    name.trim() !== "" &&
    (mode !== "existing" || existing !== "") &&
    (mode !== "remote" || remoteUrl.trim() !== "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        data-testid="projects__create"
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is a body of work across repos, with its own context repo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="projects-name">Name</Label>
            <Input
              id="projects-name"
              data-testid="projects__name"
              value={name}
              placeholder="checkout-revamp"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits, hyphens and underscores. The context repo gets the same
              name.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="projects-description">Description</Label>
            <Input
              id="projects-description"
              data-testid="projects__description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <fieldset className="space-y-1" data-testid="projects__repo-options">
            <legend className="text-sm font-medium">Repos</legend>
            {repos.length === 0 ? (
              <p className="text-xs text-muted-foreground">Add a repo to Band first.</p>
            ) : null}
            {repos.map((repo) => (
              <div key={repo.name} className="flex items-center gap-2">
                <label className="flex flex-1 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="projects__repo-option"
                    data-repo={repo.name}
                    checked={picked.includes(repo.name)}
                    onChange={() => toggle(repo.name)}
                  />
                  {repo.name}
                </label>
                {picked.includes(repo.name) ? (
                  <Input
                    aria-label={`Role of ${repo.name}`}
                    data-testid="projects__repo-role"
                    data-repo={repo.name}
                    className="h-7 w-32"
                    placeholder="role"
                    value={roles[repo.name] ?? ""}
                    onChange={(e) => setRoles((cur) => ({ ...cur, [repo.name]: e.target.value }))}
                  />
                ) : null}
              </div>
            ))}
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="projects-context-mode">Context repo</Label>
            <select
              id="projects-context-mode"
              data-testid="projects__context-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as ContextMode)}
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="new">Create a new one</option>
              <option value="existing">Use an existing project context</option>
              <option value="remote">Create one linked to a remote</option>
            </select>
            {mode === "existing" ? (
              <select
                aria-label="Existing context"
                data-testid="projects__context-existing"
                value={existing}
                onChange={(e) => setExisting(e.target.value)}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Choose a context</option>
                {free.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : null}
            {mode === "remote" ? (
              <Input
                aria-label="Remote URL"
                data-testid="projects__context-remote"
                placeholder="https://github.com/acme/context.git"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
              />
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Label>Coordinator model</Label>
            <ModelSelect value={model} onChange={setModel} testId="projects__create-model" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="projects-labels">Host labels</Label>
            <Input
              id="projects-labels"
              data-testid="projects__labels"
              placeholder="team=payments os=linux"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </div>
          <ErrorLine message={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="projects__create-submit" disabled={!ready || busy} onClick={submit}>
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(project.description);
  const [labels, setLabels] = useState(project.labels.join(" "));
  const [model, setModel] = useState(project.coordinatorModel);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      await trpc.projects.update.mutate({
        project: project.id,
        description,
        labels: splitLabels(labels),
        coordinatorModel: model,
      });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="projects__edit">
        <DialogHeader>
          <DialogTitle>Edit {project.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="projects-edit-description">Description</Label>
            <Input
              id="projects-edit-description"
              data-testid="projects__edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="projects-edit-labels">Host labels</Label>
            <Input
              id="projects-edit-labels"
              data-testid="projects__edit-labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label>Coordinator model</Label>
            <ModelSelect value={model} onChange={setModel} testId="projects__edit-model" />
          </div>
          <ErrorLine message={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="projects__edit-save" onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectDetail({
  project,
  canEdit,
  onBack,
  onOpenContext,
}: {
  project: Project;
  canEdit: boolean;
  onBack: () => void;
  onOpenContext: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const { repos } = useRepos();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [addRepo, setAddRepo] = useState("");
  const [addRole, setAddRole] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const inProject = new Set(project.repos.map((r) => r.repo));
  const addable = repos.filter((r) => !inProject.has(r.name));
  const byRepo = new Map<string, Project["worktrees"]>();
  for (const wt of project.worktrees) byRepo.set(wt.repo, [...(byRepo.get(wt.repo) ?? []), wt]);

  return (
    <div className="space-y-4" data-testid="projects__detail" data-project={project.name}>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" data-testid="projects__back" onClick={onBack}>
          Back to projects
        </Button>
        {canEdit ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="projects__edit-open"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            {confirming ? (
              <Button
                size="sm"
                variant="destructive"
                data-testid="projects__remove-confirm"
                onClick={() =>
                  run(async () => {
                    await trpc.projects.remove.mutate({ project: project.id });
                    onBack();
                  })
                }
              >
                Confirm remove
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                data-testid="projects__remove"
                onClick={() => setConfirming(true)}
              >
                Remove
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <div>
        <h2 className="text-lg font-semibold" data-testid="projects__detail-name">
          {project.name}
        </h2>
        <p className="text-sm text-muted-foreground" data-testid="projects__detail-description">
          {project.description || "No description."}
        </p>
        {project.labels.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="projects__detail-labels">
            Host labels: {project.labels.join(", ")}
          </p>
        ) : null}
      </div>

      <section className="space-y-1">
        <h3 className="text-sm font-medium">Coordinator model</h3>
        <ModelSelect
          value={project.coordinatorModel}
          disabled={!canEdit}
          onChange={(model) =>
            run(() => trpc.projects.update.mutate({ project: project.id, coordinatorModel: model }))
          }
        />
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-medium">Context repo</h3>
        <div className="flex items-center gap-2 text-sm">
          <span data-testid="projects__context-name">{project.contextName}</span>
          {project.context?.syncError ? (
            <span className="text-xs text-destructive">{project.context.syncError}</span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            data-testid="projects__context-link"
            onClick={() => onOpenContext(project.contextName)}
          >
            Browse context
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Repos</h3>
        <ul className="space-y-1">
          {project.repos.map((r) => (
            <li
              key={r.repo}
              className="flex items-center justify-between gap-2 text-sm"
              data-testid="projects__repo"
              data-repo={r.repo}
              data-role={r.role ?? ""}
            >
              <span>
                {r.repo}
                {r.role ? <span className="text-muted-foreground"> ({r.role})</span> : null}
              </span>
              {canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${r.repo}`}
                  data-testid="projects__repo-remove"
                  data-repo={r.repo}
                  onClick={() =>
                    run(() =>
                      trpc.projects.removeRepo.mutate({ project: project.id, repo: r.repo }),
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit && addable.length > 0 ? (
          <div className="flex items-center gap-2">
            <select
              aria-label="Repo to add"
              data-testid="projects__add-repo-select"
              value={addRepo}
              onChange={(e) => setAddRepo(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Add a repo</option>
              {addable.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
            <Input
              aria-label="Role of the repo to add"
              data-testid="projects__add-repo-role"
              className="h-8 w-32"
              placeholder="role"
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
            />
            <Button
              size="sm"
              data-testid="projects__add-repo"
              disabled={addRepo === ""}
              onClick={() =>
                run(async () => {
                  await trpc.projects.addRepo.mutate({
                    project: project.id,
                    repo: addRepo,
                    role: addRole.trim() || null,
                  });
                  setAddRepo("");
                  setAddRole("");
                })
              }
            >
              Add
            </Button>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Worktrees</h3>
        {project.worktrees.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="projects__no-worktrees">
            No worktrees yet.
          </p>
        ) : null}
        {[...byRepo].map(([repo, list]) => (
          <div key={repo} data-testid="projects__worktree-group" data-repo={repo}>
            <h4 className="text-xs font-medium text-muted-foreground">{repo}</h4>
            <ul>
              {list.map((wt) => (
                <li
                  key={wt.worktreeId}
                  className="text-sm"
                  data-testid="projects__worktree"
                  data-worktree={wt.worktreeId}
                >
                  {wt.branch}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <ErrorLine message={error} />
      {editing ? <EditProjectDialog project={project} open onOpenChange={setEditing} /> : null}
    </div>
  );
}

export function ProjectsDialog({
  open,
  onOpenChange,
  onOpenContext,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens Settings > Context on this context. */
  onOpenContext: (name: string) => void;
}) {
  const list = useQuery<ProjectList>({
    queryKey: PROJECTS_KEY,
    queryFn: () => trpc.projects.list.query(),
    enabled: open,
  });
  // Changing a project needs an admin token, and so does `context.list`, so it doubles as the probe.
  const admin = useQuery({
    queryKey: ["projects.admin"],
    queryFn: () => trpc.context.list.query(),
    enabled: open,
    retry: false,
  });
  const canEdit = admin.isSuccess;
  const [viewing, setViewing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const projects = list.data?.projects ?? [];
  const current = projects.find((p) => p.id === viewing) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="projects">
        <DialogHeader>
          <DialogTitle>Projects</DialogTitle>
          <DialogDescription>Bodies of work that span several repos.</DialogDescription>
        </DialogHeader>
        {current ? (
          <ProjectDetail
            project={current}
            canEdit={canEdit}
            onBack={() => setViewing(null)}
            onOpenContext={(name) => {
              onOpenChange(false);
              onOpenContext(name);
            }}
          />
        ) : (
          <div className="space-y-3" data-testid="projects__list">
            {canEdit ? (
              <Button size="sm" data-testid="projects__new" onClick={() => setCreating(true)}>
                New project
              </Button>
            ) : admin.isError ? (
              <p className="text-xs text-muted-foreground" data-testid="projects__read-only">
                Changing projects needs an admin token.
              </p>
            ) : null}
            {list.error ? <ErrorLine message={errorText(list.error)} /> : null}
            {projects.length === 0 && !list.isLoading ? (
              <p className="text-sm text-muted-foreground" data-testid="projects__empty">
                No projects yet.
              </p>
            ) : null}
            <ul className="space-y-1">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    data-testid="projects__item"
                    data-project={p.name}
                    data-repo-count={p.repos.length}
                    data-model={p.coordinatorModel}
                    onClick={() => setViewing(p.id)}
                    className="flex w-full flex-col rounded-md border px-3 py-2 text-left hover:bg-muted"
                  >
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.description ? (
                      <span className="text-xs text-muted-foreground">{p.description}</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {p.repos.length} {p.repos.length === 1 ? "repo" : "repos"} · coordinator{" "}
                      {p.coordinatorModel}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <CreateProjectDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(project) => setViewing(project.id)}
        />
      </DialogContent>
    </Dialog>
  );
}
