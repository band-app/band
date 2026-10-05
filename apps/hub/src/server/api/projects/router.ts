/**
 * `projects.*` (plan steps 6.1 and 6.2): cross-repo projects and their
 * coordinator session. Reads need any device token, changes need an admin one.
 * The MCP endpoint leaves the router out, because the coordinator has its own
 * scoped tools (`api/mcp-proxy/coordinator.ts`), and the worker relay refuses
 * it because it is not in `RELAY_PROCEDURES`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ContextInputError,
  ProjectConflictError,
  ProjectInputError,
  ProjectNotFoundError,
} from "../../errors";
import { projectCoordinatorService } from "../../services/project-coordinator-service";
import { type ProjectView, projectPolicy, projectService } from "../../services/project-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

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

/** The view with why the coordinator failed to start, when it did. */
function present(view: ProjectView) {
  return { ...view, coordinatorError: projectCoordinatorService.lastError(view.id) };
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
        description: z.string().max(2000).optional(),
        coordinatorAgent: z.string().max(100).nullable().optional(),
        coordinatorModel: z.string().min(1).max(100).optional(),
        coordinatorHostId: z.string().min(1).max(100).nullable().optional(),
        labels: labels.optional(),
        policy: projectPolicy.optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(() => {
        const { project, ...patch } = input;
        const updated = projectService.update(project, patch);
        projectCoordinatorService.syncModel(updated.id);
        return { project: present(projectService.get(updated.id)) };
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
            beforeRemove: (row) => projectCoordinatorService.teardown(row.id),
          })
          .then(() => ({ removed: true })),
      ),
    ),

  addRepo: adminProcedure
    .input(z.object({ project: ref, repo: repoName, role }))
    .mutation(({ input }) =>
      guard(async () => {
        const added = projectService.addRepo(input.project, input.repo, input.role);
        // The first repo gives the coordinator a worktree to run in.
        const project = added.coordinator
          ? added
          : await projectCoordinatorService.ensureCoordinator(added.id);
        return { project: present(project) };
      }),
    ),

  /** Refused while a worktree of that repo belongs to the project. */
  removeRepo: adminProcedure
    .input(z.object({ project: ref, repo: repoName }))
    .mutation(({ input }) =>
      guard(() => ({ project: projectService.removeRepo(input.project, input.repo) })),
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
