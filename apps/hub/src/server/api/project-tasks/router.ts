/**
 * `projectTasks.*` (plan step T.2): tasks inside projects. A task is a folder on one host with a
 * BRIEF.md, one git worktree per member repo and a chat. Reads need any device token, changes need
 * an admin one, like `projects.*`. The MCP endpoint leaves the router out, because a coordinator
 * and a task's agent have their own scoped tools (`band-coordinator`, `band-task`), and the worker
 * relay refuses it because it is not in `RELAY_PROCEDURES`. The name avoids `tasks.*`, which is
 * the agent-turn queue of a chat.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ProjectConflictError,
  ProjectInputError,
  ProjectNotFoundError,
  ProjectTaskNotFoundError,
} from "../../errors";
import { dispatchPlacement } from "../../services/_utils/dispatch-input";
import { projectService } from "../../services/project-service";
import { projectTaskService } from "../../services/project-task-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

const ref = z.string().trim().min(1).max(200);
const repoName = z.string().trim().min(1).max(200);

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof ProjectTaskNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (err instanceof ProjectConflictError) {
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    }
    if (err instanceof ProjectInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

export const projectTasksRouter = t.router({
  /** The tasks of a project, newest first. Worktrees made before tasks are one-member tasks. */
  list: publicProcedure
    .input(z.object({ project: ref }))
    .query(({ input }) =>
      guard(() => ({ tasks: projectTaskService.list(projectService.row(input.project).id) })),
    ),

  /** One task by id, or by name within `project`. */
  get: publicProcedure.input(z.object({ task: ref, project: ref.optional() })).query(({ input }) =>
    guard(() => ({
      task: projectTaskService.get(
        input.task,
        input.project ? projectService.row(input.project).id : undefined,
      ),
    })),
  ),

  /**
   * Creates a task: its folder with BRIEF.md, a worktree of each repo in `repos` on `branch`, all
   * on one host, and a chat that runs in the folder. With no `repos` the task starts empty and its
   * agent adds repos itself. The call fails with the reason when no host fits every repo.
   */
  create: adminProcedure
    .input(
      z.object({
        project: ref,
        branch: z.string().trim().min(1).max(200),
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
          .optional(),
        title: z.string().max(200).optional(),
        brief: z.string().max(100_000).default(""),
        repos: z
          .array(
            z.object({
              repo: repoName,
              role: z.string().max(100).nullable().optional(),
              labels: z
                .record(z.string().min(1).max(100), z.string().max(200))
                .refine((m) => Object.keys(m).length <= 20, "at most 20 labels")
                .optional(),
            }),
          )
          .max(10)
          .default([]),
        hostId: z.string().min(1).max(200).optional(),
        placement: dispatchPlacement.optional(),
        codingAgentId: z.string().min(1).max(100).optional(),
        model: z.string().min(1).max(100).optional(),
        /** False makes the task and its chat without sending the first prompt. */
        start: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        const { project, placement, ...rest } = input;
        return projectTaskService.create(project, {
          ...rest,
          ...(placement
            ? {
                placement: {
                  ...(placement.labels ? { labels: placement.labels } : {}),
                  ...(placement.requires ? { requires: placement.requires } : {}),
                  ...(placement.isolation
                    ? { environment: { isolation: placement.isolation } }
                    : {}),
                },
              }
            : {}),
        });
      }),
    ),

  addRepo: adminProcedure
    .input(
      z.object({
        task: ref,
        project: ref.optional(),
        repo: repoName,
        role: z.string().max(100).nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => ({
        member: await projectTaskService.addRepo(
          input.task,
          { repo: input.repo, role: input.role },
          input.project ? projectService.row(input.project).id : undefined,
        ),
      })),
    ),

  /** Refused while the repo's worktree has commits that are not on the default branch or uncommitted changes. */
  removeRepo: adminProcedure
    .input(z.object({ task: ref, project: ref.optional(), repo: repoName }))
    .mutation(({ input }) =>
      guard(async () => {
        await projectTaskService.removeRepo(
          input.task,
          input.repo,
          input.project ? projectService.row(input.project).id : undefined,
        );
        return { removed: true };
      }),
    ),

  /** Removes the task, its worktrees, chats and folder. Refused while a worktree has commits or changes, unless `force`. */
  remove: adminProcedure
    .input(z.object({ task: ref, project: ref.optional(), force: z.boolean().optional() }))
    .mutation(({ input }) =>
      guard(async () => {
        await projectTaskService.remove(input.task, {
          force: input.force,
          projectId: input.project ? projectService.row(input.project).id : undefined,
        });
        return { removed: true };
      }),
    ),
});
