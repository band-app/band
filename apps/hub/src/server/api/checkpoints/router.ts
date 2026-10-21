/**
 * `checkpoints.*`: the hub's checkpoints of worktrees on static workers, offline views of them,
 * and restore / move to another host. Reads and restore / move take any device token. Adding a
 * host to the repo's allowed hosts while restoring, and moving a whole host, need an admin
 * token. The MCP endpoint and the worker relay leave the router out, so an agent cannot move
 * work between hosts.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CheckpointError, RepoHostNotAllowedError } from "../../errors";
import { checkpointService } from "../../services/checkpoint-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

function mapError(err: unknown): never {
  if (err instanceof RepoHostNotAllowedError) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message, cause: err });
  }
  if (err instanceof CheckpointError) {
    const code =
      err.code === "no-checkpoint"
        ? "NOT_FOUND"
        : err.code === "conflict"
          ? "CONFLICT"
          : "PRECONDITION_FAILED";
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return mapError(err);
  }
}

const worktreeId = z.string().min(1);
const checkpointId = z.string().min(1).optional();

export const checkpointsRouter = t.router({
  list: publicProcedure
    .input(z.object({ worktreeId }))
    .query(({ input }) => checkpointService.list(input.worktreeId)),

  /** Takes a checkpoint now. Answers `unchanged` when nothing differs from the newest one. */
  take: publicProcedure
    .input(z.object({ worktreeId }))
    .mutation(({ input }) => guard(() => checkpointService.take(input.worktreeId, "manual"))),

  changes: publicProcedure
    .input(z.object({ worktreeId, checkpointId }))
    .query(({ input }) =>
      guard(() => checkpointService.changes(input.worktreeId, input.checkpointId)),
    ),

  diff: publicProcedure
    .input(z.object({ worktreeId, path: z.string().min(1), checkpointId }))
    .query(({ input }) =>
      guard(() => checkpointService.diff(input.worktreeId, input.path, input.checkpointId)),
    ),

  files: publicProcedure
    .input(z.object({ worktreeId, checkpointId }))
    .query(({ input }) =>
      guard(() => checkpointService.files(input.worktreeId, input.checkpointId)),
    ),

  file: publicProcedure
    .input(z.object({ worktreeId, path: z.string().min(1), checkpointId }))
    .query(({ input }) =>
      guard(() => checkpointService.file(input.worktreeId, input.path, input.checkpointId)),
    ),

  /** Restores a worktree on another host from a checkpoint. The old copy is left alone, superseded. */
  restore: publicProcedure
    .input(
      z.object({
        worktreeId,
        toHostId: z.string().min(1),
        checkpointId,
        addHost: z.boolean().optional(),
        hostRepoPath: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requireAdminToAddHost(input.addHost, ctx.admin);
      return guard(() => checkpointService.restore(input));
    }),

  /** Moves a worktree whose host is online, and removes the source once the target has it. */
  move: publicProcedure
    .input(
      z.object({
        worktreeId,
        toHostId: z.string().min(1),
        addHost: z.boolean().optional(),
        hostRepoPath: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requireAdminToAddHost(input.addHost, ctx.admin);
      return guard(() => checkpointService.move(input));
    }),

  /** Moves every worktree on a host to another, one after the other. */
  evacuate: adminProcedure
    .input(
      z.object({
        fromHostId: z.string().min(1),
        toHostId: z.string().min(1),
        addHost: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => guard(() => checkpointService.evacuate(input))),

  /** The worktrees on a host that an evacuation would take. */
  evacuable: publicProcedure
    .input(z.object({ hostId: z.string().min(1) }))
    .query(({ input }) => ({ worktrees: checkpointService.evacuable(input.hostId) })),
});

function requireAdminToAddHost(addHost: boolean | undefined, admin: boolean | undefined): void {
  if (addHost && !admin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only an admin token can add a worker to a repo's allowed workers.",
    });
  }
}

export type CheckpointsRouter = typeof checkpointsRouter;
