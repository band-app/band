/**
 * Dispatch from a project coordinator (plan steps 6.3 and T.2): the `tasks_create` tool.
 *
 * A call names a branch, a brief, acceptance scenarios, the repos the task starts with (none is
 * allowed, and the agent then adds repos itself) and placement requirements. The project's policy
 * decides what happens:
 *
 * - `observe` refuses.
 * - `steer` stores the call as a pending dispatch request and answers "pending approval". The
 *   user approves or rejects it on the project page. Approval runs the dispatch, rejection drops it.
 * - `autonomous` dispatches at once.
 *
 * The limits (labels, isolation floor, concurrency, budget) are checked when the call arrives and
 * again at approval, because the project may have changed in between. A dispatch creates a task
 * (`ProjectTaskService`): its folder with BRIEF.md, one worktree per repo on one host, and a chat
 * that runs in the folder on the project's worker model lane.
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { slugifyBranchName } from "@band-app/shared/branch-name";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { DispatchInputError, ProjectInputError } from "../errors";
import {
  DispatchRequestQueries,
  type DispatchRequestRow,
} from "../infra/db/queries/dispatch-requests";
import type { ProjectRow } from "../infra/db/queries/projects";
import {
  type DispatchInput,
  normalizeStoredDispatchInput,
  parseDispatchInput,
} from "./_utils/dispatch-input";
import { isIsolationLevel, offers } from "./_utils/isolation";
import type { Placement } from "./_utils/placement-input";
import { CoordinatorToolError, projectCoordinatorService } from "./project-coordinator-service";
import { projectService } from "./project-service";
import { projectTaskService, type TaskView } from "./project-task-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("project-dispatch");

const DEFAULT_WORKER_AGENT = "claude-code";

export interface DispatchedWorktree {
  repo: string;
  worktreeId: string | null;
}

export interface DispatchResult {
  status: "dispatched";
  taskId: string;
  name: string;
  hostId: string | null;
  folder: string | null;
  chatId: string;
  worktrees: DispatchedWorktree[];
}

export interface PendingDispatchResult {
  status: "pending approval";
  requestId: string;
  message: string;
}

/** A task as the project page lists it. The name keeps the earlier "task group" wording of the page's data. */
export interface TaskGroupView {
  id: string;
  title: string;
  brief: string;
  branch: string;
  mode: string;
  mergeOrder: string[];
  createdAt: number;
  members: Array<{
    repo: string;
    worktreeId: string | null;
    hostId: string | null;
    prNumber: number | null;
    mergeOrder: number;
  }>;
}

export interface DispatchRequestView {
  id: string;
  title: string;
  status: string;
  error: string | null;
  createdAt: number;
  decidedAt: number | null;
  repos: string[];
  branch: string;
  mode: "single" | "split" | "combined";
  name: string | null;
  brief: string;
  scenarios: string[];
  placement: DispatchInput["placement"] | null;
}

/** Dispatches and approvals of one project run one at a time, so the limits are checked against settled state. */
const lanes = new Map<string, Promise<unknown>>();
function serialized<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  const next = (lanes.get(projectId) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  lanes.set(projectId, tail);
  void tail.then(() => {
    if (lanes.get(projectId) === tail) lanes.delete(projectId);
  });
  return next;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function reposOf(input: DispatchInput): string[] {
  return input.repos.map((r) => r.repo);
}

export class ProjectDispatchService {
  private readonly queries = new DispatchRequestQueries();

  // ---- the tool ---------------------------------------------------------------------

  /** The `tasks_create` call. Throws `CoordinatorToolError` for a refusal. */
  dispatch(row: ProjectRow, raw: unknown): Promise<DispatchResult | PendingDispatchResult> {
    return serialized(row.id, () => this.dispatchNow(row, raw));
  }

  private async dispatchNow(
    row: ProjectRow,
    raw: unknown,
  ): Promise<DispatchResult | PendingDispatchResult> {
    projectCoordinatorService.requireMutation(row);
    let input: DispatchInput;
    try {
      input = parseDispatchInput(raw);
    } catch (err) {
      throw new CoordinatorToolError(err instanceof Error ? err.message : String(err));
    }
    this.check(row, input);
    const { autonomy } = projectService.get(row.id).effectivePolicy;
    if (autonomy !== "autonomous") {
      const request = this.storeRequest(row, input);
      log.info({ projectId: row.id, requestId: request.id }, "dispatch waits for approval");
      return {
        status: "pending approval",
        requestId: request.id,
        message: `Project "${row.name}" is in steer mode, so the user has to approve this dispatch on the project page. Nothing was created yet. Do not call tasks_create again for it. Check tasks_list later to see whether it was approved.`,
      };
    }
    return this.execute(row, input);
  }

  private storeRequest(row: ProjectRow, input: DispatchInput): DispatchRequestRow {
    const request: DispatchRequestRow = {
      id: newId("dr"),
      projectId: row.id,
      title:
        input.title?.trim() || `${reposOf(input).join(", ") || "empty task"} on ${input.branch}`,
      input: input as unknown as Record<string, unknown>,
      status: "pending",
      error: null,
      result: null,
      createdAt: Date.now(),
      decidedAt: null,
    };
    this.queries.insertRequest(request);
    return request;
  }

  // ---- policy -----------------------------------------------------------------------

  /** Refuses a call the project's policy does not allow. Nothing has been created when it throws. */
  private check(row: ProjectRow, input: DispatchInput): void {
    const branch = slugifyBranchName(input.branch);
    if (!branch) {
      throw new CoordinatorToolError(
        `Branch name "${input.branch}" has no valid characters. Use letters, digits, "-", "_", "/" or ".".`,
      );
    }
    for (const repo of reposOf(input)) {
      try {
        projectService.resolveForWorktree(row.id, repo);
      } catch (err) {
        throw new CoordinatorToolError(err instanceof Error ? err.message : String(err));
      }
      if (worktreeService.resolve(toWorktreeId(repo, branch))) {
        throw new CoordinatorToolError(
          `Worktree ${toWorktreeId(repo, branch)} already exists. Pick another branch name, or send the work to its chat with chats_send.`,
        );
      }
    }
    this.placementFor(row, input.placement);
    projectCoordinatorService.checkDispatch(row, { newRun: true, runs: 1 });
  }

  /** The placement a worktree is created with: the caller's, narrowed to what the project allows. */
  placementFor(row: ProjectRow, requested: DispatchInput["placement"]): Placement {
    const policy = projectService.get(row.id).effectivePolicy;
    const allowed = new Set(policy.labels);
    const asked = Object.entries(requested?.labels ?? {}).map(([k, v]) => `${k}=${v}`);
    const outside = asked.filter((l) => allowed.size > 0 && !allowed.has(l));
    if (outside.length > 0) {
      throw new CoordinatorToolError(
        `Refused: label ${outside.join(", ")} is not among the labels of project "${row.name}" (${[...allowed].join(", ")}). Workers may go only on hosts with those labels.`,
      );
    }
    const isolation = requested?.isolation ?? policy.isolationFloor;
    if (!isIsolationLevel(isolation) || !offers(isolation, policy.isolationFloor)) {
      throw new CoordinatorToolError(
        `Refused: isolation ${isolation} is below the floor of project "${row.name}", which is ${policy.isolationFloor}. Ask for ${policy.isolationFloor} or stronger.`,
      );
    }
    // The project's own labels always apply, so a request that names none still stays on its hosts.
    const labels: Record<string, string> = {};
    for (const label of [...policy.labels, ...asked]) {
      const at = label.indexOf("=");
      if (at > 0) labels[label.slice(0, at)] = label.slice(at + 1);
    }
    return {
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(requested?.requires && Object.keys(requested.requires).length > 0
        ? { requires: requested.requires }
        : {}),
      ...(isolation !== "worktree" ? { environment: { isolation } } : {}),
    };
  }

  // ---- execution --------------------------------------------------------------------

  private async execute(row: ProjectRow, input: DispatchInput): Promise<DispatchResult> {
    const policy = projectService.get(row.id).effectivePolicy;
    const placement = this.placementFor(row, input.placement);
    try {
      const { task, chatId } = await projectTaskService.create(row.id, {
        name: input.name,
        branch: input.branch,
        title: input.title?.trim() || undefined,
        brief: input.brief,
        scenarios: input.scenarios,
        repos: input.repos,
        hostId: input.host,
        placement,
        codingAgentId: row.coordinatorAgent ?? DEFAULT_WORKER_AGENT,
        model: policy.models.worker,
      });
      return {
        status: "dispatched",
        taskId: task.id,
        name: task.name,
        hostId: task.hostId,
        folder: task.folder,
        chatId,
        worktrees: task.members.map((m) => ({ repo: m.repo, worktreeId: m.worktreeId })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ projectId: row.id, err }, "dispatch failed");
      if (err instanceof ProjectInputError) throw new CoordinatorToolError(message);
      throw new CoordinatorToolError(`Dispatch failed: ${message}`);
    }
  }

  // ---- approvals --------------------------------------------------------------------

  requestsOf(row: ProjectRow, status?: string): DispatchRequestView[] {
    return this.queries.requestsOf(row.id, status).map((r) => {
      const input = (normalizeStoredDispatchInput(r.input) ?? {}) as DispatchInput;
      if (!Array.isArray(input.repos)) input.repos = [];
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        error: r.error,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        repos: reposOf(input),
        branch: input.branch,
        mode: input.repos.length > 1 ? "split" : "single",
        name: input.name ?? null,
        brief: input.brief,
        scenarios: input.scenarios ?? [],
        placement: input.placement ?? null,
      };
    });
  }

  private pending(id: string): { row: ProjectRow; request: DispatchRequestRow } {
    const request = this.queries.findRequest(id);
    if (!request) throw new DispatchInputError(`No dispatch request "${id}"`);
    if (request.status !== "pending") {
      throw new DispatchInputError(`Dispatch request ${id} was already ${request.status}.`);
    }
    return { row: projectService.row(request.projectId), request };
  }

  /** Runs a pending dispatch after the user approved it. The limits are checked again. */
  approve(id: string): Promise<DispatchResult> {
    const { row } = this.pending(id);
    return serialized(row.id, () => this.approveNow(id));
  }

  private async approveNow(id: string): Promise<DispatchResult> {
    const { row, request } = this.pending(id);
    const input = parseDispatchInput(normalizeStoredDispatchInput(request.input));
    try {
      this.check(row, input);
    } catch (err) {
      // The request stays pending: a full slot or a taken branch can clear, and the user can retry or reject.
      throw new DispatchInputError(err instanceof Error ? err.message : String(err));
    }
    // Claim the request first, so a second click cannot dispatch it twice.
    if (!this.queries.decide(id, "approved")) {
      throw new DispatchInputError(`Dispatch request ${id} was already decided.`);
    }
    try {
      const result = await this.execute(row, input);
      this.queries.finish(id, "approved", { result: result as unknown as Record<string, unknown> });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.queries.finish(id, "failed", { error: message });
      throw new DispatchInputError(message);
    }
  }

  reject(id: string): void {
    this.pending(id);
    if (!this.queries.decide(id, "rejected")) {
      throw new DispatchInputError(`Dispatch request ${id} was already decided.`);
    }
  }

  // ---- tasks ------------------------------------------------------------------------

  /** The project's tasks that have a folder or several repos, for the project page. Worktrees that predate tasks are not listed. */
  groupsOf(row: ProjectRow): TaskGroupView[] {
    return projectTaskService
      .list(row.id)
      .filter((t) => t.briefPath !== null || t.members.length > 1)
      .map((t) => this.view(t));
  }

  private view(t: TaskView): TaskGroupView {
    return {
      id: t.id,
      title: t.name,
      brief: "",
      branch: t.branch,
      mode: "split",
      mergeOrder: t.members.map((m) => m.repo),
      createdAt: t.createdAt,
      members: t.members.map((m) => ({
        repo: m.repo,
        worktreeId: m.worktreeId,
        hostId: t.hostId,
        prNumber:
          m.prNumber ?? projectService.branchStatus(m.worktreeId ?? "")?.ciPr?.number ?? null,
        mergeOrder: m.mergeOrder,
      })),
    };
  }
}

export const projectDispatchService = new ProjectDispatchService();
