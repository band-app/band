/**
 * `projects.*` (plan steps 6.1 and 6.2): cross-repo projects and their
 * coordinator session. Reads need any device token, changes need an admin one.
 * The MCP endpoint leaves the router out, because the coordinator has its own
 * scoped tools (`api/mcp-proxy/coordinator.ts`), and the worker relay refuses
 * it because it is not in `RELAY_PROCEDURES`.
 */

import { RPC_INTERNAL_ERROR, RpcError } from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { projectScopeId } from "@band-app/shared/scope-id";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ContextInputError,
  ProjectConflictError,
  ProjectInputError,
  ProjectNotFoundError,
} from "../../errors";
import { clientStateService } from "../../services/client-state-service";
import { projectCoordinatorService } from "../../services/project-coordinator-service";
import { projectDashboardService } from "../../services/project-dashboard-service";
import { projectFolderService } from "../../services/project-folder-service";
import { type ProjectView, projectPolicy, projectService } from "../../services/project-service";
import { projectSubscriptionService } from "../../services/project-subscription-service";
import { terminalService } from "../../services/terminal-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

const log = createLogger("projects-router");
const ref = z.string().trim().min(1).max(200);
const repoName = z.string().trim().min(1).max(200);
const role = z.string().max(40).nullable().optional();
const labels = z.array(z.string().min(1).max(100)).max(20);

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (err instanceof ProjectConflictError) {
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    }
    if (err instanceof ProjectInputError || err instanceof ContextInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

/** A refusal from the host's git work (a bad path, nothing to commit, behind the upstream) reaches the user as a bad request. */
async function checkout<T>(fn: () => Promise<T> | T): Promise<T> {
  return guard(async () => {
    try {
      return await fn();
    } catch (err) {
      // On a worker the host's plain Error arrives as an RpcError with the internal-error code.
      const refusal =
        err instanceof Error &&
        (err.constructor === Error || (err instanceof RpcError && err.code === RPC_INTERNAL_ERROR));
      if (err instanceof Error && refusal) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
      throw err;
    }
  });
}

/** The view with why the coordinator failed to start, when it did. */
function present(view: ProjectView) {
  return {
    ...view,
    coordinatorError: projectCoordinatorService.lastError(view.id),
    coordinatorWaiting: projectCoordinatorService.isWaiting(view.id),
  };
}

export const projectsRouter = t.router({
  list: publicProcedure.query(() => ({ projects: projectService.list().map(present) })),

  /** `project` is an id or a name. */
  get: publicProcedure
    .input(z.object({ project: ref }))
    .query(({ input }) => guard(() => ({ project: present(projectService.get(input.project)) }))),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(63),
        description: z.string().max(2000).optional(),
        repos: z
          .array(z.object({ repo: repoName, role }))
          .max(100)
          .optional(),
        contextName: z.string().trim().min(1).max(63).optional(),
        remoteUrl: z.string().max(500).optional(),
        remoteVaultItemId: z.string().min(1).optional(),
        coordinatorAgent: z.string().max(100).nullable().optional(),
        coordinatorModel: z.string().min(1).max(100).optional(),
        coordinatorHostId: z.string().min(1).max(100).nullable().optional(),
        labels: labels.optional(),
        policy: projectPolicy.optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        const created = await projectService.create(input);
        // A project with repos starts its coordinator at once. One without waits for its first repo.
        return { project: present(await projectCoordinatorService.ensureCoordinator(created.id)) };
      }),
    ),

  /** Starts the coordinator chat when the project has none (it needs at least one repo). */
  startCoordinator: adminProcedure.input(z.object({ project: ref })).mutation(({ input }) =>
    guard(async () => ({
      project: present(await projectCoordinatorService.ensureCoordinator(input.project)),
    })),
  ),

  update: adminProcedure
    .input(
      z.object({
        project: ref,
        title: z.string().max(100).optional(),
        description: z.string().max(2000).optional(),
        coordinatorAgent: z.string().max(100).nullable().optional(),
        coordinatorModel: z.string().min(1).max(100).optional(),
        coordinatorHostId: z.string().min(1).max(100).nullable().optional(),
        labels: labels.optional(),
        policy: projectPolicy.optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        const { project, ...patch } = input;
        const updated = await projectCoordinatorService.update(project, patch);
        return { project: present(updated) };
      }),
    ),

  /** Refused while worktrees belong to the project. The context repo stays unless `removeContext` is true. */
  remove: adminProcedure
    .input(z.object({ project: ref, removeContext: z.boolean().optional() }))
    .mutation(({ input }) =>
      guard(() =>
        projectService
          .remove(input.project, {
            removeContext: input.removeContext,
            beforeRemove: async (row) => {
              await projectCoordinatorService.teardown(row.id);
              // The project's folder view keeps its tabs and drafts under its scope id.
              clientStateService.removeAllForWorktree(projectScopeId(row.id));
            },
          })
          .then(() => ({ removed: true })),
      ),
    ),

  /** Agents, worktrees with their PRs, spend and wake-ups, for the project's view. */
  dashboard: publicProcedure
    .input(z.object({ project: ref }))
    .query(({ input }) =>
      guard(() => projectDashboardService.dashboard(projectService.row(input.project))),
    ),

  /** Stops the running turn of one agent chat of the project. */
  stopAgent: adminProcedure
    .input(z.object({ project: ref, chatId: z.string().min(1).max(200) }))
    .mutation(({ input }) =>
      guard(() => ({
        stopped: projectDashboardService.stopAgent(projectService.row(input.project), input.chatId),
      })),
    ),

  /** What wakes the project's coordinator: its subscriptions and the recent wake-ups, with any guard that dropped one. */
  subscriptions: publicProcedure
    .input(z.object({ project: ref }))
    .query(({ input }) =>
      guard(() => projectSubscriptionService.describe(projectService.row(input.project))),
    ),

  addRepo: adminProcedure
    .input(z.object({ project: ref, repo: repoName, role }))
    .mutation(({ input }) =>
      guard(async () => {
        const added = projectService.addRepo(input.project, input.repo, input.role);
        // The first repo starts the coordinator in the project folder.
        const project = added.coordinator
          ? added
          : await projectCoordinatorService.ensureCoordinator(added.id);
        // A project that has a folder gets the new repo's checkout now.
        if (added.coordinator) {
          await projectFolderService.addRepo(projectService.row(added.id)).catch((err) => {
            log.warn({ projectId: added.id, err }, "could not check out the new repo");
          });
        }
        return { project: present(project) };
      }),
    ),

  /**
   * Refused while a worktree of that repo belongs to the project, and while the repo's checkout
   * in the project folder has uncommitted changes or unpushed commits.
   */
  removeRepo: adminProcedure
    .input(z.object({ project: ref, repo: repoName }))
    .mutation(({ input }) =>
      guard(async () => {
        const row = projectService.row(input.project);
        projectService.checkRepoRemovable(row.id, input.repo);
        try {
          await projectFolderService.removeRepo(row, input.repo);
        } catch (err) {
          throw new ProjectConflictError(err instanceof Error ? err.message : String(err));
        }
        const view = projectService.removeRepo(row.id, input.repo);
        return { project: view };
      }),
    ),

  /** What the host last reported about the project folder: each checkout's branch, ahead, behind and dirty state. */
  folder: publicProcedure.input(z.object({ project: ref })).query(({ input }) =>
    guard(() => {
      const row = projectService.row(input.project);
      return { folder: projectFolderService.state(row.id) ?? null };
    }),
  ),

  /**
   * Makes sure the project folder exists on its coordinator host, without fetching, and returns
   * its state. The project's view calls it when it opens, so its files resolve after a restart. A
   * folder this hub already prepared answers from memory, so opening the view again clones and
   * pulls nothing. Making the repo checkouts can clone, so only an admin token does that; another
   * token gets the folder and its context, and `null` until an admin or the coordinator prepares
   * the checkouts.
   */
  prepareFolder: publicProcedure.input(z.object({ project: ref })).mutation(({ input, ctx }) =>
    guard(async () => {
      const row = projectService.row(input.project);
      return { folder: await projectFolderService.prepare(row, { checkouts: ctx.admin }) };
    }),
  ),

  /** Fetches and fast-forwards the checkouts that are clean, now. Dirty or ahead ones are left alone. */
  syncFolder: adminProcedure.input(z.object({ project: ref })).mutation(({ input }) =>
    guard(async () => {
      const row = projectService.row(input.project);
      return { folder: await projectFolderService.ensure(row, "force") };
    }),
  ),

  /** Code browser (T.1b): every call is scoped to one repo of the project and its checkout on the coordinator host. */
  codeRead: publicProcedure
    .input(z.object({ project: ref, repo: repoName, path: z.string().max(1000).default("") }))
    .query(({ input }) =>
      checkout(() =>
        projectFolderService.read(projectService.row(input.project), input.repo, input.path),
      ),
    ),

  codeSearch: publicProcedure
    .input(z.object({ project: ref, repo: repoName, query: z.string().trim().min(1).max(200) }))
    .query(({ input }) =>
      checkout(() =>
        projectFolderService.search(projectService.row(input.project), input.repo, input.query),
      ),
    ),

  codeStatus: publicProcedure
    .input(z.object({ project: ref, repo: repoName }))
    .query(({ input }) =>
      checkout(() => projectFolderService.status(projectService.row(input.project), input.repo)),
    ),

  codeLog: publicProcedure
    .input(
      z.object({ project: ref, repo: repoName, n: z.number().int().min(1).max(100).default(20) }),
    )
    .query(({ input }) =>
      checkout(() =>
        projectFolderService.log(projectService.row(input.project), input.repo, input.n),
      ),
    ),

  codeDiff: publicProcedure
    .input(
      z.object({
        project: ref,
        repo: repoName,
        target: z.union([
          z.object({ kind: z.literal("working") }),
          z.object({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{7,64}$/) }),
        ]),
        path: z.string().max(1000).optional(),
      }),
    )
    .query(({ input }) =>
      checkout(() =>
        projectFolderService.diff(
          projectService.row(input.project),
          input.repo,
          input.target,
          input.path,
        ),
      ),
    ),

  codeOpenWork: publicProcedure
    .input(z.object({ project: ref, repo: repoName }))
    .query(({ input }) =>
      checkout(() => projectFolderService.openWork(projectService.row(input.project), input.repo)),
    ),

  codeCommit: adminProcedure
    .input(
      z.object({
        project: ref,
        repo: repoName,
        message: z.string().trim().min(1).max(10_000),
        paths: z.array(z.string().min(1).max(1000)).max(500).optional(),
      }),
    )
    .mutation(({ input }) =>
      checkout(() =>
        projectFolderService.commit(
          projectService.row(input.project),
          input.repo,
          input.message,
          input.paths,
        ),
      ),
    ),

  codePush: adminProcedure
    .input(z.object({ project: ref, repo: repoName }))
    .mutation(({ input }) =>
      checkout(() => projectFolderService.push(projectService.row(input.project), input.repo)),
    ),

  codePull: adminProcedure
    .input(z.object({ project: ref, repo: repoName }))
    .mutation(({ input }) =>
      checkout(() => projectFolderService.pull(projectService.row(input.project), input.repo)),
    ),

  /** Opens a plain terminal in the project folder on its host. The WebSocket attaches by the returned scope. */
  openTerminal: adminProcedure.input(z.object({ project: ref })).mutation(({ input }) =>
    guard(async () => {
      const row = projectService.row(input.project);
      return terminalService.openProjectTerminal(row);
    }),
  ),

  attachWorktree: adminProcedure
    .input(z.object({ project: ref, worktreeId: z.string().min(1) }))
    .mutation(({ input }) =>
      guard(() => ({ project: projectService.attachWorktree(input.project, input.worktreeId) })),
    ),

  detachWorktree: adminProcedure
    .input(z.object({ worktreeId: z.string().min(1) }))
    .mutation(({ input }) =>
      guard(() => {
        projectService.detachWorktree(input.worktreeId);
        return { detached: true };
      }),
    ),
});
