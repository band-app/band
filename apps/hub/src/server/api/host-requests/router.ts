/**
 * `hostRequests.*`: worktrees waiting for a host (plan step 3.3). `list` and
 * `cancel` are for the UI and CLI. `lease`, `renew`, `fulfil` and `fail` are
 * the runner's side and need an admin token. The MCP endpoint leaves the whole
 * router out, like `hosts.*`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  HostRequestError,
  leaseFilterInput,
  placementService,
} from "../../services/placement-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

function toTrpc(err: unknown): never {
  if (err instanceof HostRequestError) {
    throw new TRPCError({
      code: err.reason === "not-found" ? "NOT_FOUND" : "CONFLICT",
      message: err.message,
    });
  }
  throw err;
}

const requestId = z.object({ requestId: z.string().min(1) });
const runnerId = z.string().min(1).max(200);
const ttlMs = z.number().int().min(1).optional();

export const hostRequestsRouter = t.router({
  // The UI only needs these fields. `input` holds the agent prompt and host paths.
  list: publicProcedure.query(() => ({
    requests: placementService.list().map((r) => ({
      id: r.id,
      worktreeId: r.worktreeId,
      repo: r.repo,
      branch: r.branch,
      labels: r.labels,
      requires: r.requires,
      status: r.status,
      hostId: r.hostId,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  })),

  cancel: publicProcedure.input(requestId).mutation(({ input }) => {
    try {
      return { request: placementService.cancel(input.requestId) };
    } catch (err) {
      toTrpc(err);
    }
  }),

  lease: adminProcedure
    .input(z.object({ runnerId, filter: leaseFilterInput.optional(), ttlMs }))
    .mutation(({ input }) => ({
      request: placementService.lease(input.runnerId, input.filter ?? {}, input.ttlMs),
    })),

  renew: adminProcedure.input(requestId.extend({ runnerId, ttlMs })).mutation(({ input }) => {
    try {
      return { request: placementService.renew(input.requestId, input.runnerId, input.ttlMs) };
    } catch (err) {
      toTrpc(err);
    }
  }),

  fulfil: adminProcedure
    .input(
      requestId.extend({
        runnerId,
        hostId: z.string().min(1),
        hostRepoPath: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        return {
          request: placementService.fulfil(
            input.requestId,
            input.runnerId,
            input.hostId,
            input.hostRepoPath,
          ),
        };
      } catch (err) {
        toTrpc(err);
      }
    }),

  fail: adminProcedure
    .input(requestId.extend({ reason: z.string().min(1).max(2000) }))
    .mutation(({ input }) => {
      try {
        return { request: placementService.fail(input.requestId, input.reason) };
      } catch (err) {
        toTrpc(err);
      }
    }),
});
