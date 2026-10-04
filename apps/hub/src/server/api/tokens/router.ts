/**
 * `tokens.*` — device tokens and worker bootstrap tokens. Thin: validates
 * input and delegates to `TokenService`. The MCP endpoint skips this
 * namespace (`src/mcp/server.ts`), so an agent can't mint or list tokens.
 *
 * A new token's secret is in the `create` response only. The hub keeps its
 * hash and can't show it again.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { SharedTokenRevokeError, TokenNotFoundError } from "../../errors";
import { MAX_BOOTSTRAP_TTL_MS, tokenService } from "../../services/token-service";
import { publicProcedure, t } from "../trpc";

const label = z.string().trim().min(1).max(100);

export const tokensRouter = t.router({
  list: publicProcedure.query(() => ({ tokens: tokenService.list() })),

  createDevice: publicProcedure.input(z.object({ label })).mutation(({ input }) => {
    const { token, view } = tokenService.createDevice(input.label);
    return { token, view };
  }),

  issueWorkerBootstrap: publicProcedure
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

  revoke: publicProcedure.input(z.object({ tokenId: z.string().min(1) })).mutation(({ input }) => {
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
