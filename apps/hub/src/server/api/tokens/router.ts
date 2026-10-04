/**
 * `tokens.*` — device tokens and worker bootstrap tokens. Thin: validates
 * input and delegates to `TokenService`. Every procedure needs an admin
 * device token (403 otherwise). The MCP endpoint leaves out every
 * `tokens.*` procedure, so an agent can't mint or list tokens.
 *
 * A new token's secret is in the `create` response only. The hub keeps its
 * hash and can't show it again.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { SharedTokenRevokeError, TokenNotFoundError } from "../../errors";
import {
  DEFAULT_LIST_LIMIT,
  MAX_BOOTSTRAP_TTL_MS,
  MAX_LIST_LIMIT,
  tokenService,
} from "../../services/token-service";
import { adminProcedure, t } from "../trpc";

const label = z.string().trim().min(1).max(100);

export const tokensRouter = t.router({
  list: adminProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT) })
        .default({ limit: DEFAULT_LIST_LIMIT }),
    )
    .query(({ input }) => ({ tokens: tokenService.list(input.limit) })),

  createDevice: adminProcedure
    .input(z.object({ label, admin: z.boolean().default(false) }))
    .mutation(({ input }) => {
      const { token, view } = tokenService.createDevice(input.label, input.admin);
      return { token, view };
    }),

  issueWorkerBootstrap: adminProcedure
    .input(
      z.object({
        hostName: label,
        labels: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
        ttlMinutes: z
          .number()
          .int()
          .min(1)
          .max(MAX_BOOTSTRAP_TTL_MS / 60_000)
          .default(60),
      }),
    )
    .mutation(({ input }) => {
      const { token, hostId, view } = tokenService.issueWorkerBootstrap(
        input.hostName,
        input.labels,
        input.ttlMinutes * 60_000,
      );
      return { token, hostId, view };
    }),

  revoke: adminProcedure.input(z.object({ tokenId: z.string().min(1) })).mutation(({ input }) => {
    try {
      return { token: tokenService.revoke(input.tokenId) };
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
      if (err instanceof SharedTokenRevokeError) {
        throw new TRPCError({ code: "CONFLICT", message: err.message });
      }
      throw err;
    }
  }),
});
