/**
 * Dispatch from a project coordinator (plan step 6.3): the `worktrees_create` tool.
 *
 * A call names a repo, or a group of repos, with a branch, a brief, acceptance scenarios and
 * placement requirements. The project's policy decides what happens:
 *
 * - `observe` refuses.
 * - `steer` stores the call as a pending dispatch request and answers "pending approval". The
 *   user approves or rejects it on the project page. Approval runs the dispatch, rejection drops it.
 * - `autonomous` dispatches at once.
 *
 * The limits (labels, isolation floor, concurrency, budget) are checked when the call arrives and
 * again at approval, because the project may have changed in between. A dispatch creates one
 * worktree per repo under the project, writes `.am/BRIEF.md` in each through the worktree's host,
 * and starts a worker agent on the project's worker model lane with a prompt that points at it.
 * A group is recorded as a task group (plan section 13). Mode `split` is one worktree and agent
 * per repo on the same branch. Mode `combined` needs the multi-repo worktree root of the next
 * phase and is refused for now.
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { slugifyBranchName } from "@band-app/shared/branch-name";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import type { ProjectRow } from "../infra/db/queries/projects";
import {
  type DispatchRequestRow,
  type TaskGroupMemberRow,
  TaskGroupQueries,
  type TaskGroupRow,
} from "../infra/db/queries/task-groups";
import { type BriefSibling, renderBrief, workerPrompt } from "./_utils/dispatch-brief";
import { type DispatchInput, parseDispatchInput } from "./_utils/dispatch-input";
import { isIsolationLevel, offers } from "./_utils/isolation";
import type { Placement } from "./_utils/placement-input";
import { CoordinatorToolError, projectCoordinatorService } from "./project-coordinator-service";
import { projectService } from "./project-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("project-dispatch");

const DEFAULT_WORKER_AGENT = "claude-code";

export interface DispatchedWorktree {
  repo: string;
  worktreeId: string;
  /** Set while no host fits yet. The worktree is created, with its brief and agent, once one does. */
  provisioning?: { requestId: string };
}

export interface DispatchResult {
  status: "dispatched";
  groupId?: string;
  worktrees: DispatchedWorktree[];
}

export interface PendingDispatchResult {
  status: "pending approval";
  requestId: string;
  message: string;
}

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
  brief: string;
  scenarios: string[];
  placement: DispatchInput["placement"] | null;
}

export class DispatchInputError extends Error {}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function reposOf(input: DispatchInput): string[] {
  return input.group ? input.group.repos.map((r) => r.repo) : [input.repo as string];
}

export class ProjectDispatchService {
  private readonly queries = new TaskGroupQueries();

  // ---- the tool ---------------------------------------------------------------------

  /** The `worktrees_create` call. Throws `CoordinatorToolError` for a refusal. */
  async dispatch(row: ProjectRow, raw: unknown): Promise<DispatchResult | PendingDispatchResult> {
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
        message: `Project "${row.name}" is in steer mode, so the user has to approve this dispatch on the project page. Nothing was created yet. Do not call worktrees_create again for it. Check worktrees_list later to see whether it was approved.`,
      };
    }
    return this.execute(row, input);
  }

  private storeRequest(row: ProjectRow, input: DispatchInput): DispatchRequestRow {
    const request: DispatchRequestRow = {
      id: newId("dr"),
      projectId: row.id,
      title: input.title?.trim() || `${reposOf(input).join(", ")} on ${input.branch}`,
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
    if (input.group?.mode === "combined") {
      throw new CoordinatorToolError(
        "Refused: group mode combined needs the multi-repo worktree root, which Band does not have yet. Use mode split, one worktree and agent per repo.",
      );
    }
    const branch = slugifyBranchName(input.branch);
    if (!branch) {
      throw new CoordinatorToolError(
        `Branch name "${input.branch}" has no valid characters. Use letters, digits, "-", "_", "/" or ".".`,
      );
    }
    const repos = reposOf(input);
    for (const repo of repos) {
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
    projectCoordinatorService.checkDispatch(row, { newRun: true, runs: repos.length });
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
    const branch = slugifyBranchName(input.branch);
    const policy = projectService.get(row.id).effectivePolicy;
    const placement = this.placementFor(row, input.placement);
    const agent = row.coordinatorAgent ?? DEFAULT_WORKER_AGENT;
    const repos = reposOf(input);
    const mergeOrder = input.group?.mergeOrder ?? repos;
    const groupId = input.group ? newId("tg") : undefined;
    const roles = new Map((input.group?.repos ?? []).map((r) => [r.repo, r.role ?? null]));
    const title = input.title?.trim() || undefined;

    const created: DispatchedWorktree[] = [];
    const hostIds = new Map<string, string | null>();
    let failure: { repo: string; message: string } | undefined;
    for (const repo of repos) {
      const siblings: BriefSibling[] = repos
        .filter((r) => r !== repo)
        .map((r) => ({ repo: r, worktreeId: toWorktreeId(r, branch), role: roles.get(r) }));
      const brief = renderBrief({
        title,
        branch,
        repo,
        brief: input.brief,
        scenarios: input.scenarios,
        ...(groupId && input.group
          ? { group: { id: groupId, mode: "split", mergeOrder, siblings } }
          : {}),
      });
      try {
        const result = await worktreeService.create({
          repo,
          branch,
          projectId: row.id,
          placement,
          brief,
          prompt: workerPrompt(),
          codingAgentId: agent,
          model: policy.models.worker,
          agentMode: "gui",
        });
        const worktreeId = toWorktreeId(repo, branch);
        created.push({
          repo,
          worktreeId,
          ...(result.provisioning ? { provisioning: result.provisioning } : {}),
        });
        hostIds.set(repo, result.provisioning ? null : this.hostOf(worktreeId));
      } catch (err) {
        failure = { repo, message: err instanceof Error ? err.message : String(err) };
        log.warn({ projectId: row.id, repo, err }, "dispatch failed for a repo");
        break;
      }
    }

    if (groupId && input.group && created.length > 0) {
      this.queries.insertGroup(
        {
          id: groupId,
          projectId: row.id,
          title: title ?? `${repos.join(", ")} on ${branch}`,
          brief: input.brief,
          branch,
          mode: input.group.mode,
          createdAt: Date.now(),
        },
        created.map((c) => ({
          repo: c.repo,
          worktreeId: c.worktreeId,
          hostId: hostIds.get(c.repo) ?? null,
          mergeOrder: mergeOrder.indexOf(c.repo),
        })),
      );
    }
    if (failure) {
      const done = created.length
        ? ` Created before the failure: ${created.map((c) => c.worktreeId).join(", ")}.`
        : "";
      throw new CoordinatorToolError(
        `Dispatch failed for repo ${failure.repo}: ${failure.message}${done}`,
      );
    }
    return {
      status: "dispatched",
      ...(groupId ? { groupId } : {}),
      worktrees: created,
    };
  }

  private hostOf(worktreeId: string): string | null {
    return worktreeService.resolve(worktreeId)?.host.id ?? null;
  }

  // ---- approvals --------------------------------------------------------------------

  requestsOf(row: ProjectRow, status?: string): DispatchRequestView[] {
    return this.queries.requestsOf(row.id, status).map((r) => {
      const input = r.input as unknown as DispatchInput;
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        error: r.error,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        repos: reposOf(input),
        branch: input.branch,
        mode: input.group ? input.group.mode : "single",
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
  async approve(id: string): Promise<DispatchResult> {
    const { row, request } = this.pending(id);
    const input = parseDispatchInput(request.input);
    try {
      this.check(row, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.queries.decide(id, "failed", { error: message });
      throw new DispatchInputError(message);
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

  // ---- task groups ------------------------------------------------------------------

  groupsOf(row: ProjectRow): TaskGroupView[] {
    return this.queries.groupsOf(row.id).map((g) => this.view(g));
  }

  private view(g: TaskGroupRow): TaskGroupView {
    const members: TaskGroupMemberRow[] = this.queries.membersOf(g.id);
    return {
      id: g.id,
      title: g.title,
      brief: g.brief,
      branch: g.branch,
      mode: g.mode,
      mergeOrder: members.map((m) => m.repo),
      createdAt: g.createdAt,
      members: members.map((m) => ({
        repo: m.repo,
        worktreeId: m.worktreeId,
        // A member placed after provisioning has no stored host, so read the live one.
        hostId: m.hostId ?? (m.worktreeId ? this.hostOf(m.worktreeId) : null),
        prNumber:
          m.prNumber ?? projectService.branchStatus(m.worktreeId ?? "")?.ciPr?.number ?? null,
        mergeOrder: m.mergeOrder,
      })),
    };
  }
}

export const projectDispatchService = new ProjectDispatchService();
