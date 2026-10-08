/**
 * Dispatch from a project coordinator: the `worktree_create` tool.
 *
 * A call names one repo of the project, a branch, a brief, acceptance scenarios and placement
 * requirements. Work across several repos takes one call per repo, and the coordinator keeps the
 * agents in step. The project's policy decides what happens: `observe` refuses, and `autonomous`
 * dispatches at once.
 *
 * The limits (labels, isolation floor, concurrency, budget) are checked when the call arrives. A
 * dispatch is `worktrees.create` with the project, the brief in `.am/BRIEF.md` and the worker
 * prompt, so the agent starts in a chat on the project's worker model lane.
 */

import { createLogger } from "@band-app/logger";
import { slugifyBranchName } from "@band-app/shared/branch-name";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { ProjectInputError } from "../errors";
import type { ProjectRow } from "../infra/db/queries/projects";
import { isLocalHostEnabled } from "../infra/host/local-host-enabled";
import { renderBrief, workerPrompt } from "./_utils/dispatch-brief";
import { type DispatchInput, parseDispatchInput } from "./_utils/dispatch-input";
import { isIsolationLevel, offers } from "./_utils/isolation";
import type { Placement } from "./_utils/placement-input";
import { chatService } from "./chat-service";
import { CoordinatorToolError, projectCoordinatorService } from "./project-coordinator-service";
import { projectService } from "./project-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("project-dispatch");

const DEFAULT_WORKER_AGENT = "claude-code";

export interface DispatchResult {
  /** `provisioning`: no attached host fit, a runner was asked for a machine and the worktree is made when it connects. */
  status: "dispatched" | "provisioning";
  repo: string;
  branch: string;
  worktreeId: string;
  /** The worker's chat, where its agent runs. Null while provisioning. */
  chatId: string | null;
  path: string | null;
  /** The host request of a `provisioning` result. */
  requestId?: string;
}

/** Dispatches of one project run one at a time, so the limits are checked against settled state. */
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

export class ProjectDispatchService {
  // ---- the tool ---------------------------------------------------------------------

  /** The `worktree_create` call. Throws `CoordinatorToolError` for a refusal. */
  dispatch(row: ProjectRow, raw: unknown): Promise<DispatchResult> {
    return serialized(row.id, () => this.dispatchNow(row, raw));
  }

  private async dispatchNow(row: ProjectRow, raw: unknown): Promise<DispatchResult> {
    projectCoordinatorService.requireMutation(row);
    let input: DispatchInput;
    try {
      input = parseDispatchInput(raw);
    } catch (err) {
      throw new CoordinatorToolError(err instanceof Error ? err.message : String(err));
    }
    this.check(row, input);
    return this.execute(row, input);
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
    try {
      projectService.resolveForWorktree(row.id, input.repo);
    } catch (err) {
      throw new CoordinatorToolError(err instanceof Error ? err.message : String(err));
    }
    // `worktrees.create` returns an existing worktree as it is, so a taken branch is refused here.
    if (worktreeService.resolve(toWorktreeId(input.repo, branch))) {
      throw new CoordinatorToolError(
        `Worktree ${toWorktreeId(input.repo, branch)} already exists. Pick another branch name, or send the work to its chat with chats_send.`,
      );
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
    const branch = slugifyBranchName(input.branch);
    const worktreeId = toWorktreeId(input.repo, branch);
    try {
      const created = await worktreeService.create({
        repo: input.repo,
        branch,
        projectId: row.id,
        // With the hub's own machine off there is no default host, so a call that names no
        // placement still goes through placement and gets the least loaded capable worker.
        ...(Object.keys(placement).length > 0 || !isLocalHostEnabled() ? { placement } : {}),
        brief: renderBrief({
          title: input.title?.trim() || undefined,
          project: row.name,
          repo: input.repo,
          branch,
          brief: input.brief,
          scenarios: input.scenarios,
        }),
        prompt: workerPrompt(),
        codingAgentId: row.coordinatorAgent ?? DEFAULT_WORKER_AGENT,
        model: policy.models.worker,
        // A chat, so the coordinator can read it, message it and wake on its turns.
        agentMode: "gui",
      });
      if (created.provisioning) {
        return {
          status: "provisioning",
          repo: input.repo,
          branch,
          worktreeId,
          chatId: null,
          path: null,
          requestId: created.provisioning.requestId,
        };
      }
      return {
        status: "dispatched",
        repo: input.repo,
        branch,
        worktreeId,
        chatId: chatService.list(worktreeId)[0]?.id ?? null,
        path: created.path,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ projectId: row.id, err }, "dispatch failed");
      if (err instanceof ProjectInputError) throw new CoordinatorToolError(message);
      throw new CoordinatorToolError(`Dispatch failed: ${message}`);
    }
  }
}

export const projectDispatchService = new ProjectDispatchService();
