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
import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useAdapter } from "../context";
import { useRepos } from "../hooks/use-repos";
import { ProjectAddRepoDialog } from "./ProjectAddRepoDialog";

type ProjectList = Awaited<ReturnType<typeof trpc.projects.list.query>>;
type Project = ProjectList["projects"][number];

const PROJECTS_KEY = ["projects.list"] as const;
const DEFAULT_MODEL = "opus";
const MODELS = ["opus", "sonnet", "haiku"];
const AUTONOMY: Array<{ value: "observe" | "steer" | "autonomous"; label: string }> = [
  { value: "observe", label: "Observe: read only" },
  { value: "steer", label: "Steer: message and stop workers (default)" },
  { value: "autonomous", label: "Autonomous: dispatch within the limits" },
];
const ISOLATION = ["worktree", "container", "vm"] as const;

/** The default project is named "personal"; show it capitalized. */
const projectTitle = (p: { name: string; isDefault?: boolean }) =>
  p.isDefault ? `${p.name.charAt(0).toUpperCase()}${p.name.slice(1)}` : p.name;

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
  label = "Coordinator model",
  defaultModel = DEFAULT_MODEL,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  testId?: string;
  label?: string;
  defaultModel?: string;
}) {
  const options = MODELS.includes(value) ? MODELS : [value, ...MODELS];
  return (
    <select
      aria-label={label}
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border bg-background px-2 text-sm"
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {m === defaultModel ? `${m} (default)` : m}
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

function CoordinatorSection({
  project,
  canEdit,
  run,
  onOpenWorktree,
}: {
  project: Project;
  canEdit: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onOpenWorktree: (worktreeId: string) => void;
}) {
  const coordinator = project.coordinator;
  return (
    <section
      className="space-y-1"
      data-testid="projects__coordinator"
      data-state={coordinator ? "started" : "not-started"}
    >
      <h3 className="text-sm font-medium">Coordinator</h3>
      {coordinator ? (
        <div className="flex items-center gap-2 text-sm">
          <span data-testid="projects__coordinator-worktree">{coordinator.worktreeId}</span>
          <Button
            size="sm"
            variant="outline"
            data-testid="projects__coordinator-open"
            onClick={() => onOpenWorktree(coordinator.worktreeId)}
          >
            Open coordinator chat
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="projects__coordinator-none">
          {project.repos.length === 0
            ? "Add a repo to start the coordinator."
            : "The coordinator has not started."}
        </p>
      )}
      {project.coordinatorError ? (
        <p
          role="alert"
          data-testid="projects__coordinator-error"
          className="text-xs text-destructive"
        >
          {project.coordinatorError}
        </p>
      ) : null}
      {canEdit && !coordinator && project.repos.length > 0 ? (
        <Button
          size="sm"
          data-testid="projects__coordinator-start"
          onClick={() => run(() => trpc.projects.startCoordinator.mutate({ project: project.id }))}
        >
          Start coordinator
        </Button>
      ) : null}
    </section>
  );
}

function PolicySection({
  project,
  canEdit,
  run,
}: {
  project: Project;
  canEdit: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const p = project.effectivePolicy;
  const [maxConcurrent, setMaxConcurrent] = useState(p.maxConcurrent?.toString() ?? "");
  const [budget, setBudget] = useState(p.budgetUsd?.toString() ?? "");
  const [floor, setFloor] = useState<(typeof ISOLATION)[number]>(p.isolationFloor);
  const [autoMerge, setAutoMerge] = useState(project.policy.autoMerge === true);
  const [worker, setWorker] = useState(p.models.worker);
  const [reviewer, setReviewer] = useState(p.models.reviewer);
  const [labels, setLabels] = useState(p.labels.join(" "));

  const save = () =>
    run(() =>
      trpc.projects.update.mutate({
        project: project.id,
        policy: {
          ...project.policy,
          maxConcurrent: maxConcurrent.trim() ? Number(maxConcurrent) : undefined,
          budgetUsd: budget.trim() ? Number(budget) : undefined,
          isolationFloor: floor,
          autoMerge,
          labels: splitLabels(labels),
          models: { worker, reviewer },
        },
      }),
    );

  return (
    <section className="space-y-2" data-testid="projects__policy" data-autonomy={p.autonomy}>
      <h3 className="text-sm font-medium">Policy</h3>
      <div className="flex items-center gap-2">
        <Label htmlFor="projects-autonomy">Autonomy</Label>
        <select
          id="projects-autonomy"
          data-testid="projects__autonomy"
          value={p.autonomy}
          disabled={!canEdit}
          onChange={(e) =>
            run(() =>
              trpc.projects.update.mutate({
                project: project.id,
                policy: {
                  ...project.policy,
                  autonomy: e.target.value as "observe" | "steer" | "autonomous",
                },
              }),
            )
          }
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          {AUTONOMY.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="projects-max-concurrent">Max concurrent workers</Label>
          <Input
            id="projects-max-concurrent"
            data-testid="projects__max-concurrent"
            type="number"
            min={1}
            disabled={!canEdit}
            placeholder="no limit"
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="projects-budget">Budget (USD)</Label>
          <Input
            id="projects-budget"
            data-testid="projects__budget"
            type="number"
            min={0}
            disabled={!canEdit}
            placeholder="no limit"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="projects-isolation-floor">Minimum isolation</Label>
          <select
            id="projects-isolation-floor"
            data-testid="projects__isolation-floor"
            value={floor}
            disabled={!canEdit}
            onChange={(e) => setFloor(e.target.value as (typeof ISOLATION)[number])}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          >
            {ISOLATION.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="projects-worker-labels">Worker host labels</Label>
          <Input
            id="projects-worker-labels"
            data-testid="projects__worker-labels"
            disabled={!canEdit}
            placeholder="pool=eu"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">Model lanes</span>
        <ModelSelect
          value={p.models.coordinator}
          disabled={!canEdit}
          label="Coordinator lane"
          onChange={(model) =>
            run(() => trpc.projects.update.mutate({ project: project.id, coordinatorModel: model }))
          }
        />
        <ModelSelect
          value={worker}
          disabled={!canEdit}
          label="Worker lane"
          defaultModel="sonnet"
          testId="projects__lane-worker"
          onChange={setWorker}
        />
        <ModelSelect
          value={reviewer}
          disabled={!canEdit}
          label="Reviewer lane"
          defaultModel="sonnet"
          testId="projects__lane-reviewer"
          onChange={setReviewer}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="projects__auto-merge"
          checked={autoMerge}
          disabled={!canEdit || p.autonomy !== "autonomous"}
          onChange={(e) => setAutoMerge(e.target.checked)}
        />
        Merge without asking (autonomous only)
      </label>
      {canEdit ? (
        <Button size="sm" data-testid="projects__policy-save" onClick={save}>
          Save policy
        </Button>
      ) : null}
    </section>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function DashboardSection({
  project,
  canEdit,
  onOpenWorktree,
}: {
  project: Project;
  canEdit: boolean;
  onOpenWorktree: (worktreeId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const adapter = useAdapter();
  const key = ["projects.dashboard", project.id];
  // The status stream says when chats, sessions, PRs or wake-ups change. A turn starting or ending and
  // a dispatch changing have no event of their own, so a slow poll stays as the fallback.
  useEffect(
    () =>
      adapter.subscribeStatusEvents((event) => {
        if (
          event.kind === "update" ||
          event.kind === "branch-status" ||
          event.kind === "chat-created" ||
          event.kind === "chat-removed" ||
          event.kind === "agent-session-created" ||
          event.kind === "agent-session-updated" ||
          event.kind === "agent-session-ended" ||
          event.kind === "subscription-created" ||
          event.kind === "subscription-delivered" ||
          event.kind === "subscription-removed"
        ) {
          void queryClient.invalidateQueries({ queryKey: ["projects.dashboard", project.id] });
        }
      }),
    [adapter, queryClient, project.id],
  );
  const query = useQuery({
    queryKey: key,
    queryFn: () => trpc.projects.dashboard.query({ project: project.id }),
    refetchInterval: 5000,
  });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ["projects.dispatches", project.id] });
    }
  };
  const data = query.data;
  if (!data) return null;
  const { spend } = data;
  return (
    <div className="space-y-4" data-testid="dashboard">
      <section className="space-y-2" data-testid="dashboard__agents">
        <h3 className="text-sm font-medium">Agents</h3>
        {data.agents.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="dashboard__no-agents">
            No agents yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {data.agents.map((a) => (
              <li
                key={a.chatId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                data-testid="dashboard__agent"
                data-chat={a.chatId}
                data-role={a.role}
                data-status={a.status}
              >
                <span>
                  <span className="font-medium">
                    {a.role === "coordinator" ? "Coordinator" : a.name}
                  </span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {a.repo}/{a.branch}, host {a.hostId ?? "local"}, {a.agent}
                    {a.model ? ` (${a.model})` : ""}, {usd(a.spendUsd)}
                    {a.lastActivityAt
                      ? `, active ${new Date(a.lastActivityAt).toLocaleString()}`
                      : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs" data-testid="dashboard__agent-status">
                    {a.status}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="dashboard__agent-open"
                    onClick={() => onOpenWorktree(a.worktreeId)}
                  >
                    Open chat
                  </Button>
                  {canEdit && a.status === "running" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="dashboard__agent-stop"
                      onClick={() =>
                        act(() =>
                          trpc.projects.stopAgent.mutate({ project: project.id, chatId: a.chatId }),
                        )
                      }
                    >
                      Stop
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" data-testid="dashboard__spend">
        <h3 className="text-sm font-medium">Spend</h3>
        <p className="text-sm">
          Today <span data-testid="dashboard__spend-today">{usd(spend.todayUsd)}</span>, last 7 days{" "}
          <span data-testid="dashboard__spend-week">{usd(spend.last7DaysUsd)}</span>, total{" "}
          <span data-testid="dashboard__spend-total">{usd(spend.totalUsd)}</span>
          {spend.budgetUsd !== null ? (
            <>
              , budget {usd(spend.budgetUsd)}, remaining{" "}
              <span data-testid="dashboard__spend-remaining">{usd(spend.remainingUsd ?? 0)}</span>
            </>
          ) : (
            <span className="text-muted-foreground"> (no budget set)</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          Unattributed (no chat owns it):{" "}
          <span data-testid="dashboard__spend-unattributed">{usd(spend.unattributedUsd)}</span>
        </p>
        <ul className="flex gap-3 text-xs text-muted-foreground">
          {spend.days.map((d) => (
            <li key={d.day} data-testid="dashboard__spend-day" data-day={d.day}>
              {d.day.slice(5)} {usd(d.usd)}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2" data-testid="dashboard__groups">
        <h3 className="text-sm font-medium">Task groups and pull requests</h3>
        {data.groups.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="dashboard__no-groups">
            No task groups yet.
          </p>
        ) : null}
        {data.groups.map((g) => (
          <div
            key={g.id}
            className="space-y-1 rounded-md border p-3"
            data-testid="dashboard__group"
            data-group={g.id}
          >
            <p className="text-sm font-medium">{g.title}</p>
            <ol className="list-decimal pl-5 text-sm">
              {g.members.map((m) => (
                <li
                  key={m.repo}
                  data-testid="dashboard__member"
                  data-repo={m.repo}
                  data-order={m.mergeOrder}
                  data-ci={m.ci ?? ""}
                  data-pr-state={m.pr?.state ?? ""}
                >
                  {m.repo}
                  {m.worktreeId ? `, worktree ${m.worktreeId}` : ", waiting for a host"}
                  {m.pr ? (
                    <>
                      {", "}
                      <a
                        href={m.pr.url ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                        data-testid="dashboard__member-pr"
                      >
                        PR #{m.pr.number}
                      </a>
                      {`, ${m.pr.isDraft ? "draft" : m.pr.state}`}
                    </>
                  ) : (
                    ", no PR"
                  )}
                  <span data-testid="dashboard__member-ci">{m.ci ? `, CI ${m.ci}` : ""}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      <section className="space-y-2" data-testid="dashboard__approvals">
        <h3 className="text-sm font-medium">Waiting for approval</h3>
        {data.pendingDispatches.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="dashboard__no-approvals">
            Nothing waits for approval.
          </p>
        ) : null}
        {data.pendingDispatches.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
            data-testid="dashboard__approval"
            data-dispatch={r.id}
          >
            <span>
              {r.title}{" "}
              <span className="text-xs text-muted-foreground">({r.repos.join(", ")})</span>
            </span>
            {canEdit ? (
              <Button
                size="sm"
                data-testid="dashboard__approval-approve"
                onClick={() => act(() => trpc.projects.approveDispatch.mutate({ requestId: r.id }))}
              >
                Approve
              </Button>
            ) : null}
          </div>
        ))}
      </section>

      <section className="space-y-1" data-testid="dashboard__wakeups">
        <h3 className="text-sm font-medium">Recent coordinator wake-ups</h3>
        {data.wakeups.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing has woken the coordinator yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {data.wakeups.slice(0, 5).map((w) => (
              <li key={`${w.subscriptionId}-${w.receivedAt}-${w.summary}`}>
                <span className="text-muted-foreground">
                  {new Date(w.receivedAt).toLocaleString()}:{" "}
                </span>
                {w.summary}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ErrorLine message={error} />
    </div>
  );
}

function DispatchSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dispatches = useQuery({
    queryKey: ["projects.dispatches", project.id],
    queryFn: () => trpc.projects.dispatches.query({ project: project.id }),
    refetchInterval: 2000,
  });
  const groups = useQuery({
    queryKey: ["projects.groups", project.id],
    queryFn: () => trpc.projects.groups.query({ project: project.id }),
    refetchInterval: 5000,
  });
  const decide = async (id: string, action: "approve" | "reject") => {
    setError(null);
    setBusy(id);
    try {
      if (action === "approve") await trpc.projects.approveDispatch.mutate({ requestId: id });
      else await trpc.projects.rejectDispatch.mutate({ requestId: id });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey: ["projects.dispatches", project.id] });
      await queryClient.invalidateQueries({ queryKey: ["projects.groups", project.id] });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    }
  };
  const requests = dispatches.data?.dispatches ?? [];
  const waiting = requests.filter((r) => r.status === "pending");
  const failed = requests.filter((r) => r.status === "failed");

  return (
    <>
      <section className="space-y-2" data-testid="projects__dispatches">
        <h3 className="text-sm font-medium">Dispatch requests</h3>
        {waiting.length === 0 && failed.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="projects__no-dispatches">
            Nothing waits for approval.
          </p>
        ) : null}
        {[...waiting, ...failed].map((r) => (
          <div
            key={r.id}
            className="space-y-1 rounded-md border p-3"
            data-testid="projects__dispatch"
            data-dispatch={r.id}
            data-status={r.status}
          >
            <p className="text-sm font-medium" data-testid="projects__dispatch-title">
              {r.title}
            </p>
            <p className="text-xs text-muted-foreground">
              {r.mode === "single" ? "One repo" : `Group, mode ${r.mode}`}: {r.repos.join(", ")} on
              branch {r.branch}. {r.scenarios.length} acceptance scenario
              {r.scenarios.length === 1 ? "" : "s"}.
            </p>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">{r.brief}</pre>
            {r.status === "failed" ? (
              <p className="text-xs text-destructive" data-testid="projects__dispatch-error">
                {r.error}
              </p>
            ) : canEdit ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="projects__dispatch-approve"
                  disabled={busy !== null}
                  onClick={() => decide(r.id, "approve")}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="projects__dispatch-reject"
                  disabled={busy !== null}
                  onClick={() => decide(r.id, "reject")}
                >
                  Reject
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        <ErrorLine message={error} />
      </section>

      <section className="space-y-2" data-testid="projects__groups">
        <h3 className="text-sm font-medium">Task groups</h3>
        {(groups.data?.groups ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="projects__no-groups">
            No task groups yet.
          </p>
        ) : null}
        {(groups.data?.groups ?? []).map((g) => (
          <div
            key={g.id}
            className="space-y-1 rounded-md border p-3"
            data-testid="projects__group"
            data-group={g.id}
            data-branch={g.branch}
            data-mode={g.mode}
          >
            <p className="text-sm font-medium">{g.title}</p>
            <p className="text-xs text-muted-foreground">
              Branch {g.branch}, mode {g.mode}. Pull requests merge in this order:
            </p>
            <ol className="list-decimal pl-5 text-sm">
              {g.members.map((m) => (
                <li
                  key={m.repo}
                  data-testid="projects__group-member"
                  data-repo={m.repo}
                  data-order={m.mergeOrder}
                >
                  {m.repo}
                  {m.worktreeId ? `, worktree ${m.worktreeId}` : ", waiting for a host"}
                  {m.hostId ? `, host ${m.hostId}` : ""}
                  {m.prNumber ? `, PR #${m.prNumber}` : ""}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>
    </>
  );
}

function RetroSection({
  project,
  canEdit,
  run,
}: {
  project: Project;
  canEdit: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const retro = project.effectivePolicy.retro;
  const [enabled, setEnabled] = useState(retro.enabled);
  const [cron, setCron] = useState(retro.cron);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["projects.retroStatus", project.id, retro.enabled, retro.cron],
    queryFn: () => trpc.projects.retroStatus.query({ project: project.id }),
    refetchInterval: 5000,
  });
  // The proposals hold context content, which only an admin may read.
  const proposals = useQuery({
    queryKey: ["projects.retroProposals", project.id],
    queryFn: () => trpc.projects.retroProposals.query({ project: project.id, limit: 5 }),
    enabled: canEdit,
    refetchInterval: status.data?.retro.running ? 2000 : 10000,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects.retroProposals", project.id] });
    await queryClient.invalidateQueries({ queryKey: ["projects.dispatches", project.id] });
  };
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const save = () =>
    run(() =>
      trpc.projects.update.mutate({
        project: project.id,
        policy: { ...project.policy, retro: { enabled, cron: cron.trim() || undefined } },
      }),
    );
  const next = status.data?.retro.nextRunAt;

  return (
    <section className="space-y-2" data-testid="projects__retro" data-enabled={retro.enabled}>
      <h3 className="text-sm font-medium">Retro</h3>
      <p className="text-xs text-muted-foreground">
        A retro reads the project's recent learnings, handoffs and task groups and proposes edits to
        its notes and skills. Nothing applies until you accept it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="projects__retro-enabled"
            checked={enabled}
            disabled={!canEdit}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Run on a schedule
        </label>
        <Label htmlFor="projects-retro-cron">Cron</Label>
        <Input
          id="projects-retro-cron"
          data-testid="projects__retro-cron"
          className="w-40"
          disabled={!canEdit}
          value={cron}
          onChange={(e) => setCron(e.target.value)}
        />
        {canEdit ? (
          <Button size="sm" data-testid="projects__retro-save" onClick={save}>
            Save schedule
          </Button>
        ) : null}
        {canEdit ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="projects__retro-run"
            disabled={busy !== null || status.data?.retro.running === true}
            onClick={() => act("run", () => trpc.projects.retroRun.mutate({ project: project.id }))}
          >
            Run retro now
          </Button>
        ) : null}
      </div>
      <p
        className="text-xs text-muted-foreground"
        data-testid="projects__retro-next"
        data-scheduled={retro.enabled && next ? "true" : "false"}
      >
        {retro.enabled && next
          ? `Next run ${new Date(next).toLocaleString()}.`
          : "The schedule is off."}
      </p>
      {(proposals.data?.proposals ?? []).map((p) => (
        <div
          key={p.id}
          className="space-y-2 rounded-md border p-3"
          data-testid="projects__retro-proposal"
          data-proposal={p.id}
          data-status={p.status}
        >
          <p className="text-xs text-muted-foreground">
            {new Date(p.createdAt).toLocaleString()}, {p.status}
            {p.error ? `: ${p.error}` : ""}
          </p>
          {p.summary ? <p className="text-sm">{p.summary}</p> : null}
          {p.status === "reviewed" && p.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing to change.</p>
          ) : null}
          {p.items.map((item) => (
            <div
              key={item.id}
              className="space-y-1 rounded border p-2"
              data-testid="projects__retro-item"
              data-item={item.id}
              data-path={item.path}
              data-status={item.status}
            >
              <p className="text-sm font-medium">
                {item.target === "repo" ? `${item.repo}: ` : ""}
                {item.path}
                <span className="text-xs font-normal text-muted-foreground"> ({item.status})</span>
              </p>
              <p className="text-xs text-muted-foreground">{item.rationale}</p>
              <pre
                className="max-h-48 overflow-auto whitespace-pre-wrap text-xs"
                data-testid="projects__retro-diff"
              >
                {item.diff}
              </pre>
              {item.error ? (
                <p className="text-xs text-destructive" data-testid="projects__retro-item-error">
                  {item.error}
                </p>
              ) : null}
              {item.result?.dispatch ? (
                <p className="text-xs" data-testid="projects__retro-item-result">
                  Dispatch: {item.result.dispatch}
                </p>
              ) : null}
              {canEdit && (item.status === "pending" || item.status === "failed") ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    data-testid="projects__retro-accept"
                    disabled={busy !== null}
                    onClick={() =>
                      act(item.id, () =>
                        trpc.projects.retroDecide.mutate({
                          proposalId: p.id,
                          itemId: item.id,
                          decision: "accept",
                        }),
                      )
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="projects__retro-reject"
                    disabled={busy !== null}
                    onClick={() =>
                      act(item.id, () =>
                        trpc.projects.retroDecide.mutate({
                          proposalId: p.id,
                          itemId: item.id,
                          decision: "reject",
                        }),
                      )
                    }
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      <ErrorLine message={error} />
    </section>
  );
}

function WakeupSection({ project }: { project: Project }) {
  const subscriptions = useQuery({
    queryKey: ["projects.subscriptions", project.id],
    queryFn: () => trpc.projects.subscriptions.query({ project: project.id }),
    refetchInterval: 5000,
  });
  const subs = subscriptions.data?.subscriptions ?? [];
  const wakeups = subscriptions.data?.wakeups ?? [];
  return (
    <section className="space-y-2" data-testid="projects__subscriptions">
      <h3 className="text-sm font-medium">What wakes the coordinator</h3>
      {subs.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="projects__no-subscriptions">
          No active subscriptions. They start with the coordinator.
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {subs.map((s) => (
            <li
              key={s.id}
              data-testid="projects__subscription"
              data-kind={s.kind}
              className="flex justify-between gap-2"
            >
              <span>
                {s.kind === "project" ? "Worker chats and the context inbox" : s.filterKey}
              </span>
              <span className="text-xs text-muted-foreground">
                {s.wakeups} of {s.maxWakeups} wake-ups
              </span>
            </li>
          ))}
        </ul>
      )}
      <h4 className="text-xs font-medium text-muted-foreground">Recent wake-ups</h4>
      {wakeups.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="projects__no-wakeups">
          Nothing has woken the coordinator yet.
        </p>
      ) : (
        <ul className="space-y-1 text-xs">
          {wakeups.map((w) => (
            <li
              key={`${w.subscriptionId}-${w.receivedAt}-${w.summary}`}
              data-testid="projects__wakeup"
              data-state={w.droppedReason ? "dropped" : w.deliveredAt ? "delivered" : "waiting"}
            >
              <span className="text-muted-foreground">
                {new Date(w.receivedAt).toLocaleString()}
                {w.droppedReason
                  ? `, dropped (${w.droppedReason})`
                  : w.deliveredAt
                    ? ""
                    : ", waiting"}
                {": "}
              </span>
              {w.summary}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Where a repo comes from: its URL, or the one host that holds a repo with no remote. */
function RepoLocation({
  repo,
}: {
  repo: { remoteUrl?: string; clones?: Array<{ hostId: string }> } | undefined;
}) {
  if (!repo) return null;
  if (repo.remoteUrl) {
    return (
      <span
        className="block truncate text-xs text-muted-foreground"
        data-testid="projects__repo-url"
      >
        {repo.remoteUrl}
      </span>
    );
  }
  const host = repo.clones?.[0]?.hostId;
  return (
    <span className="block text-xs text-muted-foreground" data-testid="projects__repo-local-only">
      No remote. Lives on {host ?? "one host"} only, so worktrees can run only there.
    </span>
  );
}

function ProjectDetail({
  project,
  canEdit,
  onBack,
  onOpenContext,
  onOpenWorktree,
}: {
  project: Project;
  canEdit: boolean;
  onBack: () => void;
  onOpenContext: (name: string) => void;
  onOpenWorktree: (worktreeId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { repos } = useRepos();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [addRepo, setAddRepo] = useState("");
  const [addRole, setAddRole] = useState("");
  const [addingRepo, setAddingRepo] = useState(false);

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
            {project.isDefault ? null : confirming ? (
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
          {projectTitle(project)}
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

      <DashboardSection project={project} canEdit={canEdit} onOpenWorktree={onOpenWorktree} />

      {project.isDefault ? null : (
        <>
          <CoordinatorSection
            project={project}
            canEdit={canEdit}
            run={run}
            onOpenWorktree={onOpenWorktree}
          />

          <PolicySection
            key={`${project.id}:${JSON.stringify(project.policy)}:${project.coordinatorModel}`}
            project={project}
            canEdit={canEdit}
            run={run}
          />
        </>
      )}

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
              <span className="min-w-0">
                {r.repo}
                {r.role ? <span className="text-muted-foreground"> ({r.role})</span> : null}
                <RepoLocation repo={repos.find((x) => x.name === r.repo)} />
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
        {canEdit ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="projects__add-repo-open"
            onClick={() => setAddingRepo(true)}
          >
            Add repo
          </Button>
        ) : null}
        <ProjectAddRepoDialog
          open={addingRepo}
          onOpenChange={setAddingRepo}
          projectId={project.id}
        />
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

      <DispatchSection project={project} canEdit={canEdit} />

      <RetroSection
        key={`${project.id}:${JSON.stringify(project.policy.retro ?? null)}`}
        project={project}
        canEdit={canEdit}
        run={run}
      />

      <WakeupSection project={project} />

      <ErrorLine message={error} />
      {editing ? <EditProjectDialog project={project} open onOpenChange={setEditing} /> : null}
    </div>
  );
}

export function ProjectsDialog({
  open,
  onOpenChange,
  onOpenContext,
  onOpenWorktree,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens Settings > Context on this context. */
  onOpenContext: (name: string) => void;
  /** Shows a worktree, for the coordinator's chat. */
  onOpenWorktree: (worktreeId: string) => void;
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
            onOpenWorktree={(worktreeId) => {
              onOpenChange(false);
              onOpenWorktree(worktreeId);
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
                    <span className="text-sm font-medium">{projectTitle(p)}</span>
                    {p.description ? (
                      <span className="text-xs text-muted-foreground">{p.description}</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {p.repos.length} {p.repos.length === 1 ? "repo" : "repos"}
                      {p.isDefault ? "" : ` · coordinator ${p.coordinatorModel}`}
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
