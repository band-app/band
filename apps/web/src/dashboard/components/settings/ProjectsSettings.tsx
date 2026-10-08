import { projectScopeId } from "@band-app/shared/scope-id";
import { Button, Input, Switch, Textarea } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useCapabilities } from "../../context";
import {
  errorText,
  PROJECTS_KEY,
  type Project,
  type ProjectList,
  projectTitle,
} from "../project/project-sections";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageContext, SettingsSection } from "./SettingsSection";

const LOCAL_HOST_ID = "local";
const MODELS = ["opus", "sonnet", "haiku"];
const ISOLATION = ["worktree", "container", "vm"] as const;
type Isolation = (typeof ISOLATION)[number];
type Autonomy = "observe" | "autonomous";

/** A native select styled like the settings page's other controls, so tests and keyboards drive it as one. */
const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 sm:w-56";

interface Draft {
  title: string;
  description: string;
  hostId: string;
  autonomy: Autonomy;
  autoMerge: boolean;
  maxConcurrent: string;
  budget: string;
  floor: Isolation;
  coordinatorModel: string;
  worker: string;
  reviewer: string;
}

function draftOf(project: Project): Draft {
  const p = project.effectivePolicy;
  return {
    title: project.title ?? "",
    description: project.description ?? "",
    hostId: project.coordinatorHostId ?? "",
    autonomy: p.autonomy,
    autoMerge: project.policy.autoMerge === true,
    maxConcurrent: p.maxConcurrent?.toString() ?? "",
    budget: p.budgetUsd?.toString() ?? "",
    floor: p.isolationFloor,
    coordinatorModel: p.models.coordinator,
    worker: p.models.worker,
    reviewer: p.models.reviewer,
  };
}

/**
 * One project's page in the Settings dialog, opened from its entry in the nav's Projects group.
 * The same sections and rows as the other settings pages: General, Coordinator, Workers and the
 * danger zone, with one Save for the whole page. `onDeleted` runs after a delete so the dialog can
 * leave the page.
 */
export function ProjectSettings({
  project,
  onDeleted,
}: {
  project: Project;
  onDeleted: () => void;
}) {
  // A fresh form when another project is shown or the saved values change.
  return (
    <ProjectSettingsForm
      key={`${project.id}:${JSON.stringify(draftOf(project))}`}
      project={project}
      onDeleted={onDeleted}
    />
  );
}

function ProjectSettingsForm({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  // Changing a project needs an admin token, and so does `context.list`, so it doubles as the probe.
  const admin = useQuery({
    queryKey: ["projects.admin"],
    queryFn: () => trpc.context.list.query(),
    retry: false,
  });
  const canEdit = admin.isSuccess;
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  const saved = draftOf(project);
  const [draft, setDraft] = useState<Draft>(saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const hostChoices = (hosts.data ?? []).filter(
    (h) => h.usable && (h.id === LOCAL_HOST_ID || h.status === "online" || h.id === draft.hostId),
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.projects.update.mutate({
        project: project.id,
        title: draft.title.trim(),
        description: draft.description.trim(),
        coordinatorHostId: draft.hostId || null,
        coordinatorModel: draft.coordinatorModel,
        policy: {
          ...project.policy,
          autonomy: draft.autonomy,
          autoMerge: draft.autonomy === "autonomous" && draft.autoMerge,
          maxConcurrent: draft.maxConcurrent.trim() ? Number(draft.maxConcurrent) : undefined,
          budgetUsd: draft.budget.trim() ? Number(draft.budget) : undefined,
          isolationFloor: draft.floor,
          models: { worker: draft.worker, reviewer: draft.reviewer },
        },
      });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // The page title is the project's, so each section keeps its own heading.
    <SettingsPageContext.Provider value={false}>
      <div className="space-y-6" data-testid="project-settings-page" data-project={project.name}>
        {canEdit ? null : (
          <p className="text-xs text-muted-foreground" data-testid="project-settings__read-only">
            Changing a project needs an admin token.
          </p>
        )}

        <SettingsSection
          title="General"
          action={
            canEdit ? (
              <Button
                size="sm"
                data-testid="project-settings__save"
                disabled={!dirty || busy}
                onClick={save}
              >
                Save changes
              </Button>
            ) : null
          }
        >
          <SettingsRow
            variant="responsive"
            htmlFor="project-settings-title"
            label="Title"
            description={
              <>
                Shown in the sidebar. The name <span className="font-mono">{project.name}</span>{" "}
                stays its id in the URL, the CLI and the project folder.
              </>
            }
          >
            <Input
              id="project-settings-title"
              data-testid="project-settings__title"
              className="h-8 w-full text-sm sm:w-56"
              value={draft.title}
              placeholder={project.name}
              disabled={!canEdit}
              onChange={(e) => set("title", e.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            variant="stacked"
            htmlFor="project-settings-description"
            label="Description"
            description="What the project is for. The default AGENTS.md of the project repeats it."
          >
            <Textarea
              id="project-settings-description"
              data-testid="projects__edit-description"
              className="text-sm"
              rows={3}
              value={draft.description}
              disabled={!canEdit}
              onChange={(e) => set("description", e.target.value)}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Coordinator">
          <SettingsRow
            variant="responsive"
            htmlFor="project-settings-host"
            label="Host"
            description="Where the coordinator chat and the project folder run."
          >
            <select
              id="project-settings-host"
              data-testid="project-settings__host"
              className={SELECT_CLASS}
              value={draft.hostId}
              disabled={!canEdit}
              onChange={(e) => set("hostId", e.target.value)}
            >
              <option value="">Hub default</option>
              {hostChoices.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow
            variant="responsive"
            htmlFor="project-settings-coordinator-model"
            label="Model"
          >
            <ModelSelect
              id="project-settings-coordinator-model"
              testId="projects__model-select"
              value={draft.coordinatorModel}
              defaultModel="opus"
              disabled={!canEdit}
              onChange={(m) => set("coordinatorModel", m)}
            />
          </SettingsRow>
          <SettingsRow
            variant="responsive"
            htmlFor="projects-autonomy"
            label="Autonomy"
            description="Observe only reads and reports. Autonomous starts worker agents within the limits below."
          >
            <select
              id="projects-autonomy"
              data-testid="projects__autonomy"
              className={SELECT_CLASS}
              value={draft.autonomy}
              disabled={!canEdit}
              onChange={(e) => set("autonomy", e.target.value as Autonomy)}
            >
              <option value="observe">Observe</option>
              <option value="autonomous">Autonomous (default)</option>
            </select>
          </SettingsRow>
          <SettingsRow
            htmlFor="projects-auto-merge"
            label="Merge without asking"
            description="Let the coordinator merge pull requests whose CI passed. Autonomous only."
          >
            <Switch
              id="projects-auto-merge"
              data-testid="projects__auto-merge"
              checked={draft.autonomy === "autonomous" && draft.autoMerge}
              disabled={!canEdit || draft.autonomy !== "autonomous"}
              onCheckedChange={(v) => set("autoMerge", v)}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Workers">
          <SettingsRow
            variant="responsive"
            htmlFor="projects-max-concurrent"
            label="Max concurrent workers"
            description="Worker agents running a turn at once. Empty means no limit."
          >
            <Input
              id="projects-max-concurrent"
              data-testid="projects__max-concurrent"
              className="h-8 w-full text-sm sm:w-56"
              type="number"
              min={1}
              placeholder="No limit"
              value={draft.maxConcurrent}
              disabled={!canEdit}
              onChange={(e) => set("maxConcurrent", e.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            variant="responsive"
            htmlFor="projects-budget"
            label="Budget (USD)"
            description="No new worker starts once the project has spent this. Empty means no limit."
          >
            <Input
              id="projects-budget"
              data-testid="projects__budget"
              className="h-8 w-full text-sm sm:w-56"
              type="number"
              min={0}
              placeholder="No limit"
              value={draft.budget}
              disabled={!canEdit}
              onChange={(e) => set("budget", e.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            variant="responsive"
            htmlFor="projects-isolation-floor"
            label="Minimum isolation"
            description="The weakest isolation a worker may run at: a worktree, a container or a VM."
          >
            <select
              id="projects-isolation-floor"
              data-testid="projects__isolation-floor"
              className={SELECT_CLASS}
              value={draft.floor}
              disabled={!canEdit}
              onChange={(e) => set("floor", e.target.value as Isolation)}
            >
              {ISOLATION.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow variant="responsive" htmlFor="projects-lane-worker" label="Worker model">
            <ModelSelect
              id="projects-lane-worker"
              testId="projects__lane-worker"
              value={draft.worker}
              defaultModel="sonnet"
              disabled={!canEdit}
              onChange={(m) => set("worker", m)}
            />
          </SettingsRow>
          <SettingsRow variant="responsive" htmlFor="projects-lane-reviewer" label="Reviewer model">
            <ModelSelect
              id="projects-lane-reviewer"
              testId="projects__lane-reviewer"
              value={draft.reviewer}
              defaultModel="sonnet"
              disabled={!canEdit}
              onChange={(m) => set("reviewer", m)}
            />
          </SettingsRow>
        </SettingsSection>

        {error ? (
          <p role="alert" data-testid="projects__error" className="px-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {canEdit ? <DeleteProject project={project} onDeleted={onDeleted} /> : null}
      </div>
    </SettingsPageContext.Provider>
  );
}

function ModelSelect({
  id,
  testId,
  value,
  defaultModel,
  disabled,
  onChange,
}: {
  id: string;
  testId: string;
  value: string;
  defaultModel: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const options = MODELS.includes(value) ? MODELS : [value, ...MODELS];
  return (
    <select
      id={id}
      data-testid={testId}
      className={SELECT_CLASS}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {m === defaultModel ? `${m} (default)` : m}
        </option>
      ))}
    </select>
  );
}

/** Every project for the Settings nav's Projects group. */
export function useSettingsProjects(): Project[] {
  const list = useQuery<ProjectList>({
    queryKey: PROJECTS_KEY,
    queryFn: () => trpc.projects.list.query(),
  });
  return list.data?.projects ?? [];
}

function DeleteProject({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setError(null);
    try {
      await trpc.projects.remove.mutate({ project: project.id });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      onDeleted();
      // The folder view of a deleted project has nothing left to show.
      const path = decodeURIComponent(window.location.pathname);
      if (
        path === `/worktree/${projectScopeId(project.id)}` ||
        path === `/project/${project.id}` ||
        path === `/project/${project.name}`
      ) {
        capabilities.navigate?.("/");
      }
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <SettingsSection title="Danger zone">
      <SettingsRow
        variant="responsive"
        label="Delete project"
        description="A project with worktrees can't be deleted. Its context repo stays on the hub."
      >
        {confirming ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              data-testid="projects__remove-confirm"
              onClick={remove}
            >
              Delete {projectTitle(project)}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            data-testid="projects__remove"
            onClick={() => setConfirming(true)}
          >
            Delete project
          </Button>
        )}
      </SettingsRow>
      {error ? (
        <p
          role="alert"
          data-testid="project-settings__delete-error"
          className="px-4 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
