/**
 * `context.*`: the context repos the hub holds (plan step 5.1). Every
 * procedure needs an admin device token. The MCP endpoint and the worker relay
 * leave the router out: an agent reads and writes a context through git, with
 * a token the hub gave its host.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ContextInputError, ContextNotFoundError } from "../../errors";
import { contextService } from "../../services/context-service";
import { adminProcedure, t } from "../trpc";

const name = z.string().trim().min(1).max(63);
const labels = z.array(z.string().min(1).max(100)).max(20);
const repoNames = z.array(z.string().trim().min(1).max(200)).max(100);
const workerAccess = z.enum(["read-write", "read-only"]);

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ContextNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (err instanceof ContextInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

export const contextRouter = t.router({
  list: adminProcedure.query(() => ({ contexts: contextService.list() })),

  create: adminProcedure
    .input(
      z.object({
        name,
        kind: z.enum(["user", "mission"]).optional(),
        labels: labels.optional(),
        repos: repoNames.optional(),
        workerAccess: workerAccess.optional(),
        remoteUrl: z.string().max(500).optional(),
        remoteVaultItemId: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input }) => guard(async () => ({ context: await contextService.create(input) }))),

  update: adminProcedure
    .input(
      z.object({
        name,
        labels: labels.optional(),
        repos: repoNames.optional(),
        workerAccess: workerAccess.optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(() => ({
        context: contextService.update(input.name, {
          labels: input.labels,
          repos: input.repos,
          workerAccess: input.workerAccess,
        }),
      })),
    ),

  remove: adminProcedure
    .input(z.object({ name }))
    .mutation(({ input }) =>
      guard(() => contextService.remove(input.name).then(() => ({ removed: true }))),
    ),

  /** A null `remoteUrl` unlinks. */
  linkRemote: adminProcedure
    .input(
      z.object({
        name,
        remoteUrl: z.string().max(500).nullable(),
        vaultItemId: z.string().min(1).nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => ({
        context: await contextService.linkRemote(input.name, input.remoteUrl, input.vaultItemId),
      })),
    ),

  /** Mirrors with the remote now. */
  sync: adminProcedure
    .input(z.object({ name }))
    .mutation(({ input }) => guard(() => contextService.sync(input.name))),
});
