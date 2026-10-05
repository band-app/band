/**
 * `projects.*` (plan step 6.1): cross-repo projects. Reads need any device
 * token, changes need an admin one. The MCP endpoint leaves the router out
 * until the coordinator's scoped tools arrive in step 6.2, and the worker
 * relay refuses it because it is not in `RELAY_PROCEDURES`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ContextInputError,
  ProjectConflictError,
  ProjectInputError,
  ProjectNotFoundError,
} from "../../errors";
import { projectPolicy, projectService } from "../../services/project-service";
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

export const projectsRouter = t.router({
  list: publicProcedure.query(() => ({ projects: projectService.list() })),

  /** `project` is an id or a name. */
  get: publicProcedure
    .input(z.object({ project: ref }))
    .query(({ input }) => guard(() => ({ project: projectService.get(input.project) }))),

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
        labels: labels.optional(),
        policy: projectPolicy.optional(),
      }),
    )
    .mutation(({ input }) => guard(async () => ({ project: await projectService.create(input) }))),

  update: adminProcedure
    .input(
      z.object({
        project: ref,
        description: z.string().max(2000).optional(),
        coordinatorAgent: z.string().max(100).nullable().optional(),
        coordinatorModel: z.string().min(1).max(100).optional(),
        labels: labels.optional(),
        policy: projectPolicy.optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(() => {
        const { project, ...patch } = input;
        return { project: projectService.update(project, patch) };
      }),
    ),

  /** Refused while worktrees belong to the project. The context repo stays unless `removeContext` is true. */
  remove: adminProcedure
    .input(z.object({ project: ref, removeContext: z.boolean().optional() }))
    .mutation(({ input }) =>
      guard(() =>
        projectService
          .remove(input.project, { removeContext: input.removeContext })
          .then(() => ({ removed: true })),
      ),
    ),

  addRepo: adminProcedure
    .input(z.object({ project: ref, repo: repoName, role }))
    .mutation(({ input }) =>
      guard(() => ({ project: projectService.addRepo(input.project, input.repo, input.role) })),
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
