/**
 * Projects (plan step 6.1): a cross-repo body of work. A project names the repos
 * it may touch (each with an optional role such as "api" or "client"), owns a
 * context repo (`ContextService`, kind `project`), and keeps defaults for its
 * coordinator (the session of step 6.2): the agent and model, host labels and a
 * placement policy. A worktree belongs to at most one project through
 * `worktrees.project_id`, and the agents in it read and write that project's
 * context.
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { toWorktreeId as toWorktreeIdOf } from "@band-app/shared/worktree-id";
import { ProjectConflictError, ProjectInputError, ProjectNotFoundError } from "../errors";
import type { ContextRow } from "../infra/db/queries/contexts";
import { ProjectQueries, type ProjectRow } from "../infra/db/queries/projects";
import { WorktreeQueries } from "../infra/db/queries/worktrees";
import {
  type ProjectPolicy,
  projectPolicy,
  type ResolvedPolicy,
  resolvePolicy,
} from "./_utils/project-policy";
import { CONTEXT_NAME, contextService, validateLabels } from "./context-service";
import { loadState } from "./state";

const log = createLogger("project-service");

export const DEFAULT_COORDINATOR_MODEL = "opus";
const MAX_REPOS = 100;
const ROLE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;

export { type ProjectPolicy, projectPolicy };

export interface ProjectRepoInput {
  repo: string;
  role?: string | null;
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  contextName: string;
  coordinatorAgent: string | null;
  coordinatorModel: string;
  labels: string[];
  /** What the user set. */
  policy: ProjectPolicy;
  /** The policy with its defaults filled in, which is what the coordinator runs under. */
  effectivePolicy: ResolvedPolicy;
  /** The coordinator session (plan step 6.2), or null until it has started. */
  coordinator: { worktreeId: string; chatId: string | null; hostId: string | null } | null;
  /** The host the coordinator is pinned to. Null means the hub's default. */
  coordinatorHostId: string | null;
  createdAt: number;
  /** The project that takes repos and worktrees created with no project. It cannot be removed and has no coordinator. */
  isDefault: boolean;
  repos: Array<{ repo: string; role: string | null }>;
  worktrees: Array<{
    worktreeId: string;
    repo: string;
    name: string;
    branch: string;
    path: string;
    hostId: string;
  }>;
  /** The project's context repo, or null when it was removed behind the project's back. */
  context: {
    kind: ContextRow["kind"];
    remoteUrl: string | null;
    syncError: string | null;
    lastSyncAt: number | null;
  } | null;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  repos?: ProjectRepoInput[];
  /** Use this existing project context instead of creating one. */
  contextName?: string;
  /** Link the new context repo to this remote (bring your own repo). */
  remoteUrl?: string;
  remoteVaultItemId?: string;
  coordinatorAgent?: string | null;
  coordinatorModel?: string;
  coordinatorHostId?: string | null;
  labels?: string[];
  policy?: ProjectPolicy;
}

export interface UpdateProjectInput {
  description?: string;
  coordinatorAgent?: string | null;
  coordinatorModel?: string;
  coordinatorHostId?: string | null;
  labels?: string[];
  policy?: ProjectPolicy;
}

function cleanRole(role: string | null | undefined): string | null {
  const value = role?.trim();
  if (!value) return null;
  if (!ROLE.test(value)) {
    throw new ProjectInputError(
      `Role "${value}" is letters, digits, dots, hyphens and underscores, up to 40 characters`,
    );
  }
  return value;
}

function cleanModel(model: string | undefined): string {
  const value = (model ?? DEFAULT_COORDINATOR_MODEL).trim();
  if (!value || value.length > 100) {
    throw new ProjectInputError("The coordinator model is empty or over 100 characters");
  }
  return value;
}

function cleanPolicy(policy: unknown): ProjectPolicy {
  const parsed = projectPolicy.safeParse(policy ?? {});
  if (!parsed.success) {
    throw new ProjectInputError(
      `Invalid policy: ${parsed.error.issues[0]?.message ?? "bad shape"}`,
    );
  }
  return parsed.data;
}

function labelsOf(labels: string[] | undefined): string[] {
  try {
    return validateLabels(labels ?? []);
  } catch (err) {
    throw new ProjectInputError(err instanceof Error ? err.message : String(err));
  }
}

export const DEFAULT_PROJECT_NAME = "personal";

export class ProjectService {
  private defaultPending: Promise<ProjectRow> | null = null;

  constructor(
    private readonly queries = new ProjectQueries(),
    private readonly worktreeQueries = new WorktreeQueries(),
  ) {}

  list(): ProjectView[] {
    const repos = this.queries.allRepos();
    return this.queries.list().map((row) =>
      this.toView(
        row,
        repos.filter((r) => r.projectId === row.id),
      ),
    );
  }

  /** Looks a project up by id or name. */
  get(ref: string): ProjectView {
    return this.toView(this.require(ref));
  }

  async create(input: CreateProjectInput): Promise<ProjectView> {
    const name = input.name.trim();
    if (!CONTEXT_NAME.test(name)) {
      throw new ProjectInputError(
        "A project name is lowercase letters, digits, hyphens and underscores, starting with a letter or digit",
      );
    }
    if (/^prj-[0-9a-f]{12}$/.test(name)) {
      throw new ProjectInputError("That name is reserved for project ids");
    }
    if (this.queries.findByName(name)) {
      throw new ProjectConflictError(`Project "${name}" already exists`);
    }
    const description = (input.description ?? "").trim();
    if (description.length > 2000)
      throw new ProjectInputError("The description is over 2000 characters");
    const repos = this.checkRepos(input.repos ?? []);
    const labels = labelsOf(input.labels);
    const policy = cleanPolicy(input.policy);
    const coordinatorModel = cleanModel(input.coordinatorModel);
    const agent = input.coordinatorAgent?.trim() || null;
    if (agent && agent.length > 100)
      throw new ProjectInputError("The coordinator agent is over 100 characters");

    let contextName: string;
    let createdContext = false;
    if (input.contextName) {
      if (input.remoteUrl) {
        throw new ProjectInputError("Pass either contextName or remoteUrl, not both");
      }
      const ctx = contextService.find(input.contextName.trim());
      if (!ctx) throw new ProjectInputError(`No context named "${input.contextName}"`);
      if (ctx.kind !== "project") {
        throw new ProjectInputError(
          `Context "${ctx.name}" is the user context, not a project context`,
        );
      }
      const owner = this.queries.findByContext(ctx.name);
      if (owner) {
        throw new ProjectConflictError(
          `Context "${ctx.name}" already belongs to project "${owner.name}"`,
        );
      }
      contextName = ctx.name;
    } else {
      if (contextService.find(name)) {
        throw new ProjectConflictError(
          `A context named "${name}" already exists. Pass contextName to use it for this project.`,
        );
      }
      try {
        await contextService.create({
          name,
          kind: "project",
          remoteUrl: input.remoteUrl,
          remoteVaultItemId: input.remoteVaultItemId,
        });
      } catch (err) {
        throw new ProjectInputError(err instanceof Error ? err.message : String(err));
      }
      contextName = name;
      createdContext = true;
    }

    const row: ProjectRow = {
      id: `prj-${randomBytes(6).toString("hex")}`,
      name,
      description,
      contextName,
      coordinatorAgent: agent,
      coordinatorModel,
      labels,
      policy,
      coordinatorWorktreeId: null,
      coordinatorChatId: null,
      coordinatorHostId: input.coordinatorHostId?.trim() || null,
      createdAt: Date.now(),
      isDefault: false,
    };
    try {
      this.queries.insert(row, repos);
    } catch (err) {
      if (createdContext) await contextService.remove(contextName).catch(() => {});
      if (err instanceof Error && /UNIQUE constraint failed.*projects/i.test(err.message)) {
        throw new ProjectConflictError(`Project "${name}" already exists`);
      }
      throw err;
    }
    log.info(`created project ${name} with ${repos.length} repos`);
    return this.get(row.id);
  }

  update(ref: string, patch: UpdateProjectInput): ProjectView {
    const row = this.require(ref);
    const set: Partial<ProjectRow> = {};
    if (patch.description !== undefined) {
      const description = patch.description.trim();
      if (description.length > 2000)
        throw new ProjectInputError("The description is over 2000 characters");
      set.description = description;
    }
    if (patch.coordinatorAgent !== undefined) {
      const agent = patch.coordinatorAgent?.trim() || null;
      if (agent && agent.length > 100)
        throw new ProjectInputError("The coordinator agent is over 100 characters");
      set.coordinatorAgent = agent;
    }
    if (patch.coordinatorModel !== undefined)
      set.coordinatorModel = cleanModel(patch.coordinatorModel);
    if (patch.coordinatorHostId !== undefined) {
      set.coordinatorHostId = patch.coordinatorHostId?.trim() || null;
    }
    if (patch.labels) set.labels = labelsOf(patch.labels);
    if (patch.policy) {
      set.policy = cleanPolicy(patch.policy);
      // The coordinator lane and the coordinator model are one setting.
      const lane = (set.policy as ProjectPolicy).models?.coordinator;
      if (lane && patch.coordinatorModel === undefined) set.coordinatorModel = cleanModel(lane);
    }
    if (Object.keys(set).length > 0) this.queries.update(row.id, set);
    return this.get(row.id);
  }

  /** Removes the project. A project with worktrees is refused. The context repo stays unless `removeContext` is set. */
  async remove(
    ref: string,
    opts: { removeContext?: boolean; beforeRemove?: (row: ProjectRow) => Promise<void> } = {},
  ): Promise<void> {
    const row = this.require(ref);
    if (row.isDefault) {
      throw new ProjectConflictError(
        `Project "${row.name}" is the default project and cannot be removed`,
      );
    }
    const attached = this.workersOf(row);
    if (attached.length > 0) {
      throw new ProjectConflictError(
        `Project "${row.name}" still has ${attached.length} worktree${attached.length === 1 ? "" : "s"} (${this.describe(attached)}). Detach or remove them first.`,
      );
    }
    // The coordinator's chat and worktree go first, while the project still names them.
    await opts.beforeRemove?.(row);
    this.queries.remove(row.id);
    if (opts.removeContext && contextService.find(row.contextName)) {
      await contextService.remove(row.contextName);
    }
    log.info(`removed project ${row.name}`);
  }

  /**
   * The project that takes repos and worktrees created with none ("personal"), made on first use.
   * It has a context repo like any project but never gets a coordinator.
   */
  async ensureDefault(): Promise<ProjectRow> {
    const existing = this.queries.findDefault();
    if (existing) return existing;
    this.defaultPending ??= (async () => {
      const taken = (name: string) => this.queries.findByName(name) || contextService.find(name);
      let name = DEFAULT_PROJECT_NAME;
      for (let n = 2; taken(name); n++) name = `${DEFAULT_PROJECT_NAME}-${n}`;
      await contextService.create({ name, kind: "project" });
      const row: ProjectRow = {
        id: `prj-${randomBytes(6).toString("hex")}`,
        name,
        description: "Repos and worktrees you add without choosing a project.",
        contextName: name,
        coordinatorAgent: null,
        coordinatorModel: DEFAULT_COORDINATOR_MODEL,
        labels: [],
        policy: {},
        coordinatorWorktreeId: null,
        coordinatorChatId: null,
        coordinatorHostId: null,
        createdAt: Date.now(),
        isDefault: true,
      };
      this.queries.insert(row, []);
      log.info(`created default project ${name}`);
      return row;
    })().finally(() => {
      this.defaultPending = null;
    });
    return this.defaultPending;
  }

  /** The default project's id, or undefined before {@link ensureDefault} has run. */
  defaultProjectId(): string | undefined {
    return this.queries.findDefault()?.id;
  }

  /**
   * Makes sure the default project exists and puts the repos and worktrees that belong to no
   * project into it. A repo in another project stays there, and so do its worktrees.
   */
  async adoptUnplaced(
    repos: Array<{ name: string; worktrees: Array<{ name: string }> }>,
  ): Promise<void> {
    const row = await this.ensureDefault();
    for (const repo of repos) {
      if (this.queries.projectsOfRepo(repo.name).length === 0) {
        this.queries.upsertRepo(row.id, repo.name, null);
      }
      if (!this.queries.projectsOfRepo(repo.name).includes(row.id)) continue;
      for (const wt of repo.worktrees) {
        const id = toWorktreeIdOf(repo.name, wt.name);
        if (this.worktreeQueries.findProjectId(id) === null) {
          this.worktreeQueries.setProjectId(id, row.id);
        }
      }
    }
  }

  /** The default project's id when it lists the repo, so a worktree made with no project lands there. */
  defaultProjectOf(repo: string): string | undefined {
    const id = this.queries.findDefault()?.id;
    return id && this.queries.projectsOfRepo(repo).includes(id) ? id : undefined;
  }

  /** Puts a repo in the default project, unless it is in one already. */
  async placeInDefault(repo: string): Promise<void> {
    const row = await this.ensureDefault();
    if (this.queries.projectsOfRepo(repo).length === 0) this.queries.upsertRepo(row.id, repo, null);
  }

  addRepo(ref: string, repo: string, role?: string | null): ProjectView {
    const row = this.require(ref);
    const [checked] = this.checkRepos([{ repo, role }]);
    if (!checked) throw new ProjectInputError("A repo name is required");
    const current = this.queries.reposOf(row.id);
    if (!current.some((r) => r.repoName === checked.repoName) && current.length >= MAX_REPOS) {
      throw new ProjectInputError(`At most ${MAX_REPOS} repos per project`);
    }
    this.queries.upsertRepo(row.id, checked.repoName, checked.role);
    return this.get(row.id);
  }

  /** Refused while a worktree of that repo belongs to the project. */
  removeRepo(ref: string, repo: string): ProjectView {
    const row = this.require(ref);
    if (!this.queries.reposOf(row.id).some((r) => r.repoName === repo)) {
      throw new ProjectInputError(`Repo "${repo}" is not in project "${row.name}"`);
    }
    const using = this.workersOf(row).filter((w) => w.repoName === repo);
    if (using.length > 0) {
      throw new ProjectConflictError(
        `Cannot remove repo "${repo}" from project "${row.name}": ${using.length} active worktree${using.length === 1 ? "" : "s"} (${this.describe(using)}) belong${using.length === 1 ? "s" : ""} to the project. Remove or detach them first.`,
      );
    }
    this.queries.removeRepo(row.id, repo);
    return this.get(row.id);
  }

  /** Puts an existing worktree in the project. Its repo must be one of the project's. */
  attachWorktree(ref: string, worktreeId: string): ProjectView {
    const row = this.require(ref);
    const identity = this.worktreeQueries.findIdentity(worktreeId);
    if (!identity) throw new ProjectInputError(`No worktree "${worktreeId}"`);
    this.assertRepoInProject(row, identity.repo);
    this.worktreeQueries.setProjectId(worktreeId, row.id);
    return this.get(row.id);
  }

  /** Takes a worktree out of whichever project holds it. */
  detachWorktree(worktreeId: string): void {
    if (!this.worktreeQueries.setProjectId(worktreeId, null)) {
      throw new ProjectInputError(`No worktree "${worktreeId}"`);
    }
  }

  /**
   * Checks a worktree about to be created in `repo` may join the project, and returns the
   * project id to store. Called before anything is created, so a bad request leaves no trace.
   */
  resolveForWorktree(ref: string, repo: string): string {
    const row = this.require(ref);
    this.assertRepoInProject(row, repo);
    return row.id;
  }

  /** The project context of a worktree's agents, or undefined when the worktree is in no project. */
  contextForWorktree(worktreeId: string, knownProjectId?: string): ContextRow | undefined {
    // A worktree being removed has left the database, so its caller passes the project id.
    const projectId = knownProjectId ?? this.worktreeQueries.findProjectId(worktreeId);
    const project = projectId ? this.queries.find(projectId) : undefined;
    // The default project only holds repos. Its context must not shadow the one a repo is bound to.
    return project && !project.isDefault ? contextService.find(project.contextName) : undefined;
  }

  /** The project's worktrees, without the coordinator's own. */
  workersOf(row: ProjectRow) {
    return this.queries
      .worktreesOf(row.id)
      .filter((w) => toWorktreeIdOf(w.repoName, w.name) !== row.coordinatorWorktreeId);
  }

  branchStatus(worktreeId: string) {
    return this.queries.branchStatus(worktreeId);
  }

  /** Every worktree of the project, the coordinator's included. */
  allWorktreesOf(projectId: string) {
    return this.queries.worktreesOf(projectId);
  }

  /** The project row for an id or name. Throws `ProjectNotFoundError`. */
  row(ref: string): ProjectRow {
    return this.require(ref);
  }

  /** Every project row, with no repos or policy resolved. */
  rows(): ProjectRow[] {
    return this.queries.list();
  }

  find(id: string): ProjectRow | undefined {
    return this.queries.find(id);
  }

  findByContext(contextName: string): ProjectRow | undefined {
    return this.queries.findByContext(contextName);
  }

  /** The project a worker worktree belongs to. The coordinator's own worktree and a worktree in no project give undefined. */
  projectOfWorker(worktreeId: string): ProjectRow | undefined {
    const projectId = this.worktreeQueries.findProjectId(worktreeId);
    const row = projectId ? this.queries.find(projectId) : undefined;
    return row && row.coordinatorWorktreeId !== worktreeId ? row : undefined;
  }

  findByCoordinatorChat(chatId: string): ProjectRow | undefined {
    return this.queries.findByCoordinatorChat(chatId);
  }

  isCoordinatorWorktree(worktreeId: string): boolean {
    return this.queries.findByCoordinatorWorktree(worktreeId) !== undefined;
  }

  /** Records the coordinator's worktree and chat, or clears them with nulls. */
  setCoordinator(id: string, worktreeId: string | null, chatId: string | null): void {
    this.queries.update(id, { coordinatorWorktreeId: worktreeId, coordinatorChatId: chatId });
  }

  /** A repo was removed from Band: drop it from every project. */
  forgetRepo(repo: string): void {
    this.queries.removeRepoEverywhere(repo);
  }

  private require(ref: string): ProjectRow {
    const row = this.queries.find(ref) ?? this.queries.findByName(ref);
    if (!row) throw new ProjectNotFoundError(ref);
    return row;
  }

  private assertRepoInProject(row: ProjectRow, repo: string): void {
    if (!this.queries.reposOf(row.id).some((r) => r.repoName === repo)) {
      throw new ProjectInputError(
        `Repo "${repo}" is not in project "${row.name}". Add it to the project first.`,
      );
    }
  }

  private describe(worktrees: Array<{ repoName: string; name: string }>): string {
    const names = worktrees.slice(0, 3).map((w) => `${w.repoName}/${w.name}`);
    return worktrees.length > 3
      ? `${names.join(", ")} and ${worktrees.length - 3} more`
      : names.join(", ");
  }

  private checkRepos(inputs: ProjectRepoInput[]): Array<{ repoName: string; role: string | null }> {
    if (inputs.length > MAX_REPOS)
      throw new ProjectInputError(`At most ${MAX_REPOS} repos per project`);
    const known = new Set(loadState().repos.map((r) => r.name));
    const seen = new Set<string>();
    const out: Array<{ repoName: string; role: string | null }> = [];
    for (const input of inputs) {
      const repoName = input.repo.trim();
      if (!known.has(repoName)) throw new ProjectInputError(`No repo named "${repoName}"`);
      if (seen.has(repoName)) throw new ProjectInputError(`Repo "${repoName}" is listed twice`);
      seen.add(repoName);
      out.push({ repoName, role: cleanRole(input.role) });
    }
    return out;
  }

  private toView(row: ProjectRow, repoRows = this.queries.reposOf(row.id)): ProjectView {
    const ctx = contextService.find(row.contextName);
    const parsed = projectPolicy.safeParse(row.policy);
    const policy: ProjectPolicy = parsed.success ? parsed.data : {};
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      contextName: row.contextName,
      coordinatorAgent: row.coordinatorAgent,
      coordinatorModel: row.coordinatorModel,
      labels: row.labels,
      policy,
      effectivePolicy: resolvePolicy(policy, row.coordinatorModel),
      coordinator: row.coordinatorWorktreeId
        ? {
            worktreeId: row.coordinatorWorktreeId,
            chatId: row.coordinatorChatId,
            hostId: row.coordinatorHostId,
          }
        : null,
      coordinatorHostId: row.coordinatorHostId,
      createdAt: row.createdAt,
      isDefault: row.isDefault,
      repos: repoRows.map((r) => ({ repo: r.repoName, role: r.role })),
      worktrees: this.workersOf(row).map((w) => ({
        worktreeId: toWorktreeIdOf(w.repoName, w.name),
        repo: w.repoName,
        name: w.name,
        branch: w.branch,
        path: w.path,
        hostId: w.hostId,
      })),
      context: ctx
        ? {
            kind: ctx.kind,
            remoteUrl: ctx.remoteUrl,
            syncError: ctx.syncError,
            lastSyncAt: ctx.lastSyncAt,
          }
        : null,
    };
  }
}

export const projectService = new ProjectService();
