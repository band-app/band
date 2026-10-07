/**
 * Tasks (plan step T.2, section 14): the unit of work in a project.
 *
 * A task is a folder `<BAND_HOME>/projects/<project>/tasks/<task>/` on one host. It holds a
 * `BRIEF.md` and one git worktree per member repo (zero or more), and has its own chat whose
 * working directory is that folder. Members come from two places: the repos named when the task
 * is created, and `task_add_repo` calls the agent makes while it works.
 *
 * The hub composes the task from calls every host already has: `host.project.ensure` for the
 * project folder, `host.fs` for the task folder and its brief, and the worktree create path
 * (`worktreeService.create` with a `member`), so each member is a normal worktree row. That keeps
 * the worktree-centric API (changes, PR status, terminals) working for members. A worktree that
 * predates tasks, or is made on its own, is a one-member task whose folder is the worktree.
 */

import { randomBytes } from "node:crypto";
import { join, posix } from "node:path";
import { type Environment, parseEnvironment } from "@band-app/environment";
import type { Host } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { slugifyBranchName } from "@band-app/shared/branch-name";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { ProjectInputError, ProjectTaskNotFoundError } from "../errors";
import {
  ProjectTaskQueries,
  type ProjectTaskRow,
  type TaskMemberRow,
} from "../infra/db/queries/project-tasks";
import { UsageEventQueries } from "../infra/db/queries/usage-events";
import { UsageScanStateQueries } from "../infra/db/queries/usage-scan-state";
import { hostRegistry } from "../infra/host/registry";
import { taskScopeId } from "../infra/project-scope";
import { BRIEF_FILE, type BriefRepo, renderBrief, workerPrompt } from "./_utils/dispatch-brief";
import { requestedIsolation } from "./_utils/isolation";
import type { Placement } from "./_utils/placement-input";
import { TASK_SERVER } from "./_utils/project-policy";
import {
  combineEnvironments,
  type MemberEnvironment,
  mergeTaskLabels,
  primaryOf,
  unmetLabels,
} from "./_utils/task-environment";
import { chatService } from "./chat-service";
import { contextBrowserService } from "./context-browser-service";
import { placementService, type TaskRequestInput } from "./placement-service";
import { projectFolderService } from "./project-folder-service";
import { projectService } from "./project-service";
import { repoService } from "./repo-service";
import { loadState } from "./state";
import { taskService } from "./task-service";
import { tokenService } from "./token-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("project-tasks");

const DEFAULT_TASK_AGENT = "claude-code";

export interface TaskCreateInput {
  /** The task folder's name. Defaults to the branch with "/" replaced by "-". */
  name?: string;
  branch: string;
  title?: string;
  brief: string;
  scenarios?: string[];
  /** `labels` are host labels this member needs. The task's host must carry every member's. */
  repos?: Array<{ repo: string; role?: string | null; labels?: Record<string, string> }>;
  /** Where the repo of the primary member already is on the host, set when a runner cloned it. */
  hostRepoPath?: string;
  /** An `install` command of the project-level environment, run in the task folder after the members exist. */
  projectInstall?: string;
  /** The host to create the task on. Without one, `placement` and the project's labels choose. */
  hostId?: string;
  placement?: Placement;
  /** Agent, model and permission mode of the task chat. */
  codingAgentId?: string;
  model?: string;
  /** Start the task chat's agent on the worker prompt. Defaults to true. */
  start?: boolean;
}

export interface TaskMemberView {
  repo: string;
  role: string | null;
  worktreeId: string | null;
  path: string | null;
  mergeOrder: number;
  prNumber: number | null;
}

export interface TaskView {
  id: string;
  project: string;
  projectId: string;
  name: string;
  branch: string;
  hostId: string | null;
  status: string;
  /** The task folder on its host. A task that predates folders has its worktree's path. */
  folder: string | null;
  briefPath: string | null;
  createdAt: number;
  chatIds: string[];
  members: TaskMemberView[];
}

export interface TaskCreateResult {
  task: TaskView;
  chatId: string;
}

/** No attached host fits, so a runner was asked for a machine. The task is made when it connects. */
export interface TaskProvisioningResult {
  provisioning: { requestId: string };
}

export function isProvisioning(
  result: TaskCreateResult | TaskProvisioningResult,
): result is TaskProvisioningResult {
  return "provisioning" in result;
}

/** Task names are folder names. */
const TASK_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function taskNameFor(branch: string): string {
  const slug = (slugifyBranchName(branch) ?? "").replaceAll("/", "-").toLowerCase();
  return slug.replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "");
}

const isRemote = (host: Host): boolean => host.id !== hostRegistry.local.id;
const joinOn = (host: Host, ...parts: string[]): string =>
  isRemote(host) ? posix.join(...parts) : join(...parts);

export class ProjectTaskService {
  private readonly queries = new ProjectTaskQueries();
  /** Creates, member changes and removals of one task run one at a time. */
  private readonly lanes = new Map<string, Promise<unknown>>();

  private serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(key) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return next;
  }

  // ---- reads ------------------------------------------------------------------------

  find(id: string): ProjectTaskRow | undefined {
    return this.queries.find(id);
  }

  row(ref: string, projectId?: string): ProjectTaskRow {
    const found =
      this.queries.find(ref) ?? (projectId ? this.queries.findByName(projectId, ref) : undefined);
    if (!found || (projectId && found.projectId !== projectId)) {
      throw new ProjectTaskNotFoundError(ref);
    }
    return found;
  }

  list(projectId: string): TaskView[] {
    return this.queries.listOf(projectId).map((t) => this.view(t));
  }

  get(ref: string, projectId?: string): TaskView {
    return this.view(this.row(ref, projectId));
  }

  /** The task a worktree is a member of. */
  taskOfWorktree(worktreeId: string): ProjectTaskRow | undefined {
    return this.queries.memberOfWorktree(worktreeId)?.task;
  }

  /** The task a chat belongs to: a task chat, or a chat of a member worktree. */
  taskOfChat(chatId: string): ProjectTaskRow | undefined {
    const chat = chatService.get(chatId);
    if (!chat) return undefined;
    if (chat.taskId) return this.queries.find(chat.taskId);
    return chat.worktreeId ? this.taskOfWorktree(chat.worktreeId) : undefined;
  }

  /** The host a task's folder is on, or null while it has none. */
  hostOf(task: ProjectTaskRow): Host | null {
    return task.hostId ? hostRegistry.hostById(task.hostId) : null;
  }

  /** The task folder: the directory of its BRIEF.md, or the worktree's path for a one-member task. */
  folderOf(task: ProjectTaskRow): string | null {
    if (task.briefPath) {
      const remote = task.hostId !== null && task.hostId !== hostRegistry.local.id;
      return remote ? posix.dirname(task.briefPath) : join(task.briefPath, "..");
    }
    const [member] = this.queries.membersOf(task.id);
    const wt = member?.worktreeId ? worktreeService.resolve(member.worktreeId) : null;
    return wt?.worktree.path ?? null;
  }

  private view(task: ProjectTaskRow): TaskView {
    const members = this.queries.membersOf(task.id).map((m): TaskMemberView => {
      const wt = m.worktreeId ? worktreeService.resolve(m.worktreeId) : null;
      return {
        repo: m.repoName,
        role: m.role,
        worktreeId: m.worktreeId,
        path: wt?.worktree.path ?? null,
        mergeOrder: m.mergeOrder,
        prNumber: m.prNumber,
      };
    });
    const chatIds = [
      ...chatService.listForTask(task.id).map((c) => c.id),
      ...members
        .flatMap((m) => (m.worktreeId ? chatService.list(m.worktreeId) : []))
        .map((c) => c.id),
    ];
    return {
      id: task.id,
      project: projectService.find(task.projectId)?.name ?? "",
      projectId: task.projectId,
      name: task.name,
      branch: task.branch,
      hostId: task.hostId,
      status: task.status,
      folder: this.folderOf(task),
      briefPath: task.briefPath,
      createdAt: task.createdAt,
      chatIds: [...new Set(chatIds)],
      members,
    };
  }

  // ---- placement --------------------------------------------------------------------

  /**
   * The one host a task goes on: the named one, or the least loaded online host that has the
   * project's labels, the placement's and every member's, and can hold every member repo. When no
   * attached host fits, a configured runner that offers all those labels and the isolation may
   * start one (`request`). Throws the reason, naming the member and label, when neither can,
   * because a task is never split across hosts.
   */
  private async chooseHost(
    projectId: string,
    members: Array<{ repo: string; labels?: Record<string, string> }>,
    hostId: string | undefined,
    placement: Placement | undefined,
  ): Promise<{ host: Host } | { request: Placement }> {
    const project = projectService.get(projectId);
    const base: Record<string, string> = { ...(placement?.labels ?? {}) };
    for (const label of project.effectivePolicy.labels) {
      const at = label.indexOf("=");
      if (at > 0) base[label.slice(0, at)] = label.slice(at + 1);
    }
    const merged = mergeTaskLabels(base, members);
    if (merged.conflicts.length > 0) {
      throw new ProjectInputError(
        `No host can satisfy every repo of this task: ${merged.conflicts.join("; ")}. A task runs on one host, so split it into tasks or change the labels.`,
      );
    }
    const labels = merged.labels;
    const wanted: Placement = {
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(placement?.requires ? { requires: placement.requires } : {}),
      ...(placement?.environment ? { environment: placement.environment } : {}),
    };
    const isolation = requestedIsolation(placement?.environment ?? null);
    const repos = members.map((m) => m.repo);

    // A repo with no remote URL lives on the hosts that hold it, so a task with such a repo is limited to them.
    let only: string[] | undefined;
    for (const repo of repos) {
      const holders = placementService.holdersOfRemotelessRepo(repo);
      if (holders === null) continue;
      only = only ? only.filter((h) => holders.includes(h)) : holders;
    }
    const wantedLabels = Object.entries(labels).map(([k, v]) => `${k}=${v}`);

    if (hostId) {
      const row = tokenService.listHosts(1000).find((h) => h.id === hostId);
      if (!row) throw new ProjectInputError(`Unknown host "${hostId}".`);
      if (row.status !== "online" || !row.usable) {
        throw new ProjectInputError(
          `Host "${hostId}" is ${row.status}, so no task can start on it.`,
        );
      }
      const have = await this.labelsOf(hostId);
      const missing = unmetLabels(base, members, [...have]);
      if (missing.length > 0) {
        throw new ProjectInputError(
          `Host "${hostId}" lacks the label${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`,
        );
      }
      if (only && !only.includes(hostId)) {
        throw new ProjectInputError(
          `A repo of this task has no remote URL and is held only by ${only.join(", ") || "no host"}, not by "${hostId}".`,
        );
      }
      return { host: hostRegistry.hostById(hostId) };
    }
    const placed = await placementService.place(wanted, only);
    if (placed) return { host: hostRegistry.hostById(placed) };

    // No attached host fits. A runner may start a machine, unless a repo can only run where it already is.
    if (!only && placementService.runnersFor(labels, isolation).length > 0) {
      return { request: wanted };
    }
    const needs = [
      ...wantedLabels.map((l) => `label ${l}`),
      ...Object.entries(wanted.requires ?? {}).map(([k, v]) => `${k} ${v}`),
      ...(isolation !== "worktree" ? [`isolation ${isolation}`] : []),
    ];
    const offers = placementService.runnerOffers();
    const why =
      offers.length === 0
        ? "No runner is configured"
        : offers
            .map((r) => {
              const lacks = unmetLabels(base, members, r.labels);
              return `runner ${r.id} ${
                lacks.length > 0
                  ? `lacks ${lacks.join(", ")}`
                  : `offers isolation ${r.isolation} only`
              }`;
            })
            .join("; ");
    throw new ProjectInputError(
      `No online host fits this task${needs.length ? ` (it needs ${needs.join(", ")})` : ""}${
        only
          ? `, with every repo reachable: the repos without a remote URL are held only by ${only.join(", ") || "no host"}`
          : `, and no runner can start one. ${why}`
      }. A task runs on one host, so it is not split across hosts. Pick another host or change the placement.`,
    );
  }

  /** The labels of a host: the ones set on its record and the ones the worker reports (`k=v`). */
  private async labelsOf(hostId: string): Promise<Set<string>> {
    const row = tokenService.listHosts(1000).find((h) => h.id === hostId);
    const reported =
      hostId === hostRegistry.local.id ? await hostRegistry.local.info().catch(() => null) : null;
    const stored = Array.isArray(row?.info?.labels) ? (row?.info?.labels as string[]) : [];
    return new Set([...(row?.labels ?? []), ...stored, ...(reported?.labels ?? [])]);
  }

  // ---- create -----------------------------------------------------------------------

  /** Creates a task: its folder, brief, member worktrees and chat. A failure undoes what it made. */
  create(
    projectRef: string,
    input: TaskCreateInput,
  ): Promise<TaskCreateResult | TaskProvisioningResult> {
    const project = projectService.row(projectRef);
    return this.serialized(`project:${project.id}`, () => this.createNow(project.id, input));
  }

  /**
   * Creates the task of a fulfilled task request on the machine a runner started. The request
   * was made after no attached host fit, so this names the host and skips the choice.
   */
  async createFromRequest(
    task: TaskRequestInput,
    hostId: string,
    hostRepoPath?: string,
  ): Promise<{ taskId: string }> {
    const input = {
      ...(task.create as unknown as TaskCreateInput),
      hostId,
      ...(hostRepoPath ? { hostRepoPath } : {}),
    };
    const project = projectService.row(task.projectId);
    const result = await this.serialized(`project:${project.id}`, () =>
      this.createNow(project.id, input),
    );
    if (isProvisioning(result)) throw new Error("A task on a named host cannot need provisioning");
    return { taskId: result.task.id };
  }

  /** Removes a task made for a request that was cancelled meanwhile. */
  removeForced(taskId: string): Promise<void> {
    return this.remove(taskId, { force: true });
  }

  /**
   * The one environment of a task with several members (plan step T.4): the project context's
   * `.band/environment.json` when it has one, else the primary member's. Members' own files are
   * read from the hub's checkout when it has one.
   */
  private async combinedEnvironment(
    projectId: string,
    members: Array<{ repo: string; role: string | null }>,
  ) {
    const project = projectService.row(projectId);
    let projectEnv: Environment | null = null;
    const file = await contextBrowserService
      .file(project.contextName, ".band/environment.json")
      .catch(() => null);
    if (file && !file.binary && file.content !== null) {
      const parsed = parseEnvironment(file.content);
      if (!parsed.ok) {
        throw new ProjectInputError(
          `The project environment ${project.contextName}:.band/environment.json is invalid: ${parsed.issues
            .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
            .join("; ")}`,
        );
      }
      if (parsed.environment.build?.dockerfile || parsed.environment.build?.devcontainer) {
        throw new ProjectInputError(
          `The project environment ${project.contextName}:.band/environment.json builds from a dockerfile or devcontainer, which a runner cannot do yet. Use build.image.`,
        );
      }
      projectEnv = parsed.environment;
    }
    const envs: MemberEnvironment[] = [];
    for (const [i, m] of members.entries()) {
      const path = repoService.findPath(m.repo);
      const report = path
        ? await hostRegistry.local.scripts
            .environment({ repoPath: path, worktreePath: path })
            .catch(() => null)
        : null;
      envs.push({
        repo: m.repo,
        role: m.role,
        mergeOrder: i,
        environment: report?.environment ?? null,
      });
    }
    return combineEnvironments(envs, projectEnv);
  }

  private async createNow(
    projectId: string,
    input: TaskCreateInput,
  ): Promise<TaskCreateResult | TaskProvisioningResult> {
    const project = projectService.get(projectId);
    const branch = slugifyBranchName(input.branch);
    if (!branch) {
      throw new ProjectInputError(
        `Branch name "${input.branch}" has no valid characters. Use letters, digits, "-", "_", "/" or ".".`,
      );
    }
    const name = input.name ?? taskNameFor(branch);
    if (!TASK_NAME.test(name)) {
      throw new ProjectInputError(
        `Task name "${name}" must be lowercase letters, digits, ".", "_" and "-".`,
      );
    }
    if (this.queries.findByName(projectId, name)) {
      throw new ProjectInputError(
        `Project "${project.name}" already has a task named "${name}". Pick another name or branch.`,
      );
    }
    const wanted = input.repos ?? [];
    const repoNames = wanted.map((r) => r.repo);
    if (new Set(repoNames).size !== repoNames.length) {
      throw new ProjectInputError("A repo appears twice in repos.");
    }
    for (const repo of repoNames) {
      projectService.resolveForWorktree(projectId, repo);
      if (worktreeService.resolve(toWorktreeId(repo, branch))) {
        throw new ProjectInputError(
          `Worktree ${toWorktreeId(repo, branch)} already exists. Pick another branch name.`,
        );
      }
    }

    const chosen = await this.chooseHost(projectId, wanted, input.hostId, input.placement);
    if ("request" in chosen) {
      const roles = wanted.map((r) => ({
        repo: r.repo,
        role: r.role ?? projectRoleOf(project.repos, r.repo),
      }));
      const combined = await this.combinedEnvironment(projectId, roles);
      const isolation = requestedIsolation(chosen.request.environment ?? null);
      const environment = {
        ...combined.environment,
        ...(isolation !== "worktree" ? { isolation } : {}),
      };
      const { hostId: _h, placement: _p, ...replay } = input;
      const primary = primaryOf(roles.map((r, i) => ({ ...r, mergeOrder: i })));
      const { requestId } = placementService.requestTask({
        projectId,
        name,
        repo: primary?.repo ?? "",
        branch,
        placement: { ...chosen.request, environment },
        create: {
          ...replay,
          name,
          ...(combined.source === "project" && combined.environment.install
            ? { projectInstall: combined.environment.install }
            : {}),
        },
      });
      return { provisioning: { requestId } };
    }
    const host = chosen.host;
    const projectRow = projectService.row(projectId);
    const { folder: projectFolder } = await projectFolderService.ensureOn(projectRow, host);
    const folder = joinOn(host, projectFolder, "tasks", name);
    if (
      await host.fs.stat(folder).then(
        () => true,
        () => false,
      )
    ) {
      throw new ProjectInputError(`The folder ${folder} already exists on host "${host.id}".`);
    }
    await host.fs.mkdir(folder, { recursive: true });

    const taskId = `tsk-${randomBytes(6).toString("hex")}`;
    const briefPath = joinOn(host, folder, BRIEF_FILE);
    const members: TaskMemberRow[] = wanted.map((r, i) => ({
      taskId,
      repoName: r.repo,
      worktreeId: null,
      role: r.role ?? projectRoleOf(project.repos, r.repo),
      mergeOrder: i,
      prNumber: null,
    }));
    const briefRepos: BriefRepo[] = members.map((m) => ({ repo: m.repoName, role: m.role }));
    try {
      await host.fs.writeFile(
        briefPath,
        renderBrief({
          title: input.title,
          name,
          branch,
          brief: input.brief,
          scenarios: input.scenarios ?? [],
          repos: briefRepos,
        }),
      );
      this.queries.insert(
        {
          id: taskId,
          projectId,
          name,
          branch,
          briefPath,
          hostId: host.id,
          status: "active",
          createdAt: Date.now(),
        },
        members,
      );
      const primary = primaryOf(members)?.repoName;
      for (const m of members) {
        await this.createMember(
          taskId,
          projectId,
          host,
          folder,
          m.repoName,
          branch,
          m.repoName === primary ? input.hostRepoPath : undefined,
        );
      }
      if (input.projectInstall) {
        // The project-level environment's install runs once in the task folder, after every member exists.
        await host.exec("sh", ["-c", input.projectInstall], { cwd: folder, timeoutMs: 600_000 });
      }
    } catch (err) {
      await this.undo(taskId, host, folder);
      throw err;
    }

    const task = this.row(taskId);
    const chat = chatService.createForTask(
      { id: taskId, projectId },
      {
        name: input.title?.trim() || name,
        agent: input.codingAgentId ?? projectRow.coordinatorAgent ?? DEFAULT_TASK_AGENT,
        model: input.model,
      },
    );
    if (input.start !== false) {
      taskService.submitTask({
        worktreeId: taskScopeId(taskId),
        chatId: chat.id,
        prompt: workerPrompt(),
        model: input.model,
        codingAgentId: input.codingAgentId,
      });
    }
    log.info({ taskId, projectId, host: host.id, repos: repoNames }, "task created");
    return { task: this.view(task), chatId: chat.id };
  }

  /** Creates one member's worktree in the task folder and records it. */
  private async createMember(
    taskId: string,
    projectId: string,
    host: Host,
    folder: string,
    repo: string,
    branch: string,
    hostRepoPath?: string,
  ): Promise<string> {
    await worktreeService.create(
      { repo, branch, hostId: host.id, ...(hostRepoPath ? { hostRepoPath } : {}) },
      { taskId, projectId, folder },
    );
    const worktreeId = toWorktreeId(repo, branch);
    this.queries.setMemberWorktree(taskId, repo, worktreeId);
    return worktreeId;
  }

  /** Removes what a failed create made: the member worktrees, the task row and the folder. */
  private async undo(taskId: string, host: Host, folder: string): Promise<void> {
    for (const m of this.queries.membersOf(taskId)) {
      if (!m.worktreeId) continue;
      await worktreeService
        .remove({ repo: m.repoName, name: this.nameOf(m.worktreeId, m.repoName) })
        .catch((err) => log.warn({ taskId, repo: m.repoName, err }, "could not undo a member"));
    }
    this.queries.remove(taskId);
    await host.fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }

  /** The worktree row's immutable name, which `worktrees.remove` takes. */
  private nameOf(worktreeId: string, repo: string): string {
    const entry = loadState()
      .repos.find((r) => r.name === repo)
      ?.worktrees.find((w) => toWorktreeId(repo, w.name) === worktreeId);
    return entry?.name ?? worktreeId.slice(repo.length + 1);
  }

  // ---- members ----------------------------------------------------------------------

  /** Adds a repo of the task's project to a task: a worktree on the task's branch in its folder. */
  addRepo(
    taskRef: string,
    args: { repo: string; role?: string | null },
    projectId?: string,
  ): Promise<TaskMemberView> {
    const task = this.row(taskRef, projectId);
    return this.serialized(`task:${task.id}`, async () => {
      const fresh = this.row(task.id);
      const folder = this.folderOf(fresh);
      if (!fresh.briefPath || !folder || !fresh.hostId) {
        throw new ProjectInputError(
          `Task "${fresh.name}" predates task folders, so it cannot take more repos. Create a new task instead.`,
        );
      }
      projectService.resolveForWorktree(fresh.projectId, args.repo);
      const members = this.queries.membersOf(fresh.id);
      if (members.some((m) => m.repoName === args.repo)) {
        throw new ProjectInputError(`Task "${fresh.name}" already has repo "${args.repo}".`);
      }
      const host = hostRegistry.hostById(fresh.hostId);
      const labels = projectService.get(fresh.projectId).effectivePolicy.labels;
      const have = await this.labelsOf(host.id);
      const missing = labels.filter((l) => !have.has(l));
      if (missing.length > 0) {
        throw new ProjectInputError(
          `Host "${host.id}" lacks the label${missing.length === 1 ? "" : "s"} ${missing.join(", ")} that project "${projectService.get(fresh.projectId).name}" requires for repo "${args.repo}".`,
        );
      }
      const holders = placementService.holdersOfRemotelessRepo(args.repo);
      if (holders && !holders.includes(host.id)) {
        throw new ProjectInputError(
          `Repo "${args.repo}" has no remote URL and is held only by ${holders.join(", ") || "no host"}, not by "${host.id}", where this task runs.`,
        );
      }
      const role = args.role ?? projectRoleOf(projectService.get(fresh.projectId).repos, args.repo);
      const mergeOrder = members.reduce((n, m) => Math.max(n, m.mergeOrder + 1), 0);
      this.queries.addMember({
        taskId: fresh.id,
        repoName: args.repo,
        worktreeId: null,
        role,
        mergeOrder,
        prNumber: null,
      });
      try {
        await this.createMember(fresh.id, fresh.projectId, host, folder, args.repo, fresh.branch);
      } catch (err) {
        this.queries.removeMember(fresh.id, args.repo);
        throw err;
      }
      const wt = worktreeService.resolve(toWorktreeId(args.repo, fresh.branch));
      return {
        repo: args.repo,
        role,
        worktreeId: toWorktreeId(args.repo, fresh.branch),
        path: wt?.worktree.path ?? null,
        mergeOrder,
        prNumber: null,
      };
    });
  }

  /** What stops a member from being removed: commits that are not on the default branch, or uncommitted changes. */
  private async dirtiness(host: Host, repo: string, worktreePath: string): Promise<string[]> {
    const reasons: string[] = [];
    const status = await host.git.exec(["status", "--porcelain"], worktreePath).catch((err) => {
      throw new ProjectInputError(
        `Could not read the state of ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (status.stdout.trim() !== "") reasons.push("uncommitted changes");
    const base = loadState().repos.find((r) => r.name === repo)?.defaultBranch ?? "main";
    // Compare with origin first, then the local default branch. When neither resolves the
    // member cannot be shown clean, so refuse instead of risking unpushed commits.
    let ahead: string | null = null;
    for (const ref of [`origin/${base}`, base]) {
      const out = await host.git
        .exec(["rev-list", "--count", `${ref}..HEAD`], worktreePath)
        .catch(() => null);
      if (out) {
        ahead = out.stdout.trim();
        break;
      }
    }
    if (ahead === null) {
      reasons.push(`commits that could not be checked against ${base}`);
    } else {
      const n = Number(ahead) || 0;
      if (n > 0) reasons.push(`${n} commit${n === 1 ? "" : "s"} not on ${base}`);
    }
    return reasons;
  }

  /** Removes a repo's worktree from a task. Refuses while it has commits or uncommitted changes. */
  removeRepo(taskRef: string, repo: string, projectId?: string): Promise<void> {
    const task = this.row(taskRef, projectId);
    return this.serialized(`task:${task.id}`, async () => {
      const member = this.queries.membersOf(task.id).find((m) => m.repoName === repo);
      if (!member) {
        throw new ProjectInputError(
          `Task "${task.name}" has no repo "${repo}". Its repos: ${
            this.queries
              .membersOf(task.id)
              .map((m) => m.repoName)
              .join(", ") || "none"
          }.`,
        );
      }
      const wt = member.worktreeId ? worktreeService.resolve(member.worktreeId) : null;
      if (wt) {
        const reasons = await this.dirtiness(wt.host, repo, wt.worktree.path);
        if (reasons.length > 0) {
          throw new ProjectInputError(
            `Refused: the worktree of "${repo}" in task "${task.name}" has ${reasons.join(" and ")}. Commit and push, or discard them, before removing it.`,
          );
        }
        await worktreeService.remove({ repo, name: wt.worktree.name });
      }
      // A member of a one-member task is its task: removing the worktree already dropped both.
      if (this.queries.find(task.id)) this.queries.removeMember(task.id, repo);
    });
  }

  // ---- remove -----------------------------------------------------------------------

  /**
   * Removes a task: its member worktrees, chats, folder and record. Refuses while a member has
   * commits or changes, unless `force` is set.
   */
  remove(taskRef: string, opts: { force?: boolean; projectId?: string } = {}): Promise<void> {
    const task = this.row(taskRef, opts.projectId);
    return this.serialized(`task:${task.id}`, async () => {
      const members = this.queries.membersOf(task.id);
      if (!opts.force) {
        for (const m of members) {
          const wt = m.worktreeId ? worktreeService.resolve(m.worktreeId) : null;
          if (!wt) continue;
          const reasons = await this.dirtiness(wt.host, m.repoName, wt.worktree.path);
          if (reasons.length > 0) {
            throw new ProjectInputError(
              `Refused: the worktree of "${m.repoName}" in task "${task.name}" has ${reasons.join(" and ")}. Pass force to remove it anyway.`,
            );
          }
        }
      }
      for (const m of members) {
        const wt = m.worktreeId ? worktreeService.resolve(m.worktreeId) : null;
        if (wt) await worktreeService.remove({ repo: m.repoName, name: wt.worktree.name });
      }
      for (const chat of chatService.listForTask(task.id)) chatService.remove(chat.id);
      const host = task.hostId ? hostRegistry.hostById(task.hostId) : null;
      const folder = task.briefPath ? this.folderOf(task) : null;
      if (host && folder) {
        await host.fs.rm(folder, { recursive: true, force: true }).catch((err) => {
          log.warn({ taskId: task.id, folder, err }, "could not remove the task folder");
        });
      }
      // What the task's own chat cost is recorded under its scope, like a worktree's.
      const scope = taskScopeId(task.id);
      try {
        new UsageEventQueries().deleteWorktreeEvents(scope);
        new UsageScanStateQueries().deleteWorktree(scope);
      } catch (err) {
        log.warn({ taskId: task.id, err }, "could not delete the task's usage records");
      }
      this.queries.remove(task.id);
      log.info({ taskId: task.id }, "task removed");
    });
  }

  // ---- charter ----------------------------------------------------------------------

  /**
   * What the agent of a task reads first: where it is, the repos of the project with their roles
   * and a line about each, which of them already have a worktree here, and how to add more.
   */
  charter(task: ProjectTaskRow): string {
    const project = projectService.get(task.projectId);
    const members = new Map(this.queries.membersOf(task.id).map((m) => [m.repoName, m]));
    const state = loadState();
    const lines = project.repos.map((r) => {
      const entry = state.repos.find((e) => e.name === r.repo);
      const parts = [
        r.role ? `role: ${r.role}` : "",
        entry?.label ? entry.label : "",
        entry?.remoteUrl ?? "",
        `default branch ${entry?.defaultBranch ?? "main"}`,
      ].filter(Boolean);
      const here = members.has(r.repo)
        ? `worktree in ./${r.repo}/ (read ./${r.repo}/CLAUDE.md or AGENTS.md for its rules and commands)`
        : "no worktree yet, add it with task_add_repo";
      return `- ${r.repo} (${parts.join("; ")}): ${here}`;
    });
    return [
      `You are working on the task "${task.name}" of the Band project "${project.name}", on branch ${task.branch}.`,
      `\nWorking directory. You run in the task folder, which holds BRIEF.md (the source of truth for this task) and one git worktree per repo of the task, each in a folder named after the repo. The folder above is the project's context. cd into a repo's folder to run its tests and tools. Do not create worktrees by hand.`,
      `\nRepos in this project:\n${lines.join("\n") || "- none"}`,
      `\nTools. The ${TASK_SERVER} server has task_info, task_add_repo {repo, role} and task_remove_repo {repo}. Only repos of this project can be added. task_remove_repo refuses while the worktree has commits or uncommitted changes. A refused call names the reason, so tell the user what blocked you instead of retrying.`,
    ].join("\n");
  }

  // ---- views for other services ------------------------------------------------------

  /** Every task on a host, for the sleep and wake of an ephemeral worker. */
  tasksOnHost(hostId: string): ProjectTaskRow[] {
    return this.queries.all().filter((t) => t.hostId === hostId);
  }

  /** Task records of a project, for the dashboard. */
  membersOfProject(projectId: string): TaskMemberRow[] {
    return this.queries.membersOfProject(projectId);
  }

  setMemberPr(taskId: string, repo: string, prNumber: number | null): void {
    this.queries.setMemberPr(taskId, repo, prNumber);
  }

  memberOfWorktree(worktreeId: string) {
    return this.queries.memberOfWorktree(worktreeId);
  }

  membersOf(taskId: string): TaskMemberRow[] {
    return this.queries.membersOf(taskId);
  }
}

function projectRoleOf(
  repos: Array<{ repo: string; role: string | null }>,
  repo: string,
): string | null {
  return repos.find((r) => r.repo === repo)?.role ?? null;
}

export const projectTaskService = new ProjectTaskService();

placementService.setTaskFinisher({
  create: (task, hostId, hostRepoPath) =>
    projectTaskService.createFromRequest(task, hostId, hostRepoPath),
  remove: (taskId) => projectTaskService.removeForced(taskId),
});
