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
  InvalidPairingAddressError,
  pairingAddressService,
} from "../../services/pairing-address-service";
import {
  DEFAULT_LIST_LIMIT,
  MAX_BOOTSTRAP_TTL_MS,
  MAX_LIST_LIMIT,
  tokenService,
} from "../../services/token-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

const label = z.string().trim().min(1).max(100);

export const tokensRouter = t.router({
  /** Which token this request uses. Any device token may ask; it returns no secret. */
  current: publicProcedure.query(({ ctx }) => ({
    tokenId: ctx.tokenId ?? null,
    admin: ctx.admin,
  })),

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

  /** A device with no token yet. Show its pairing link next (`pairing`). */
  createUnpairedDevice: adminProcedure
    .input(z.object({ label, admin: z.boolean().default(false) }))
    .mutation(({ input }) => ({
      view: tokenService.createUnpairedDevice(input.label, input.admin),
    })),

  /**
   * The pairing code of a device: a pending one again, or a new one with `regenerate`. It works
   * for one exchange within 15 minutes. The link is `<address>/?pair=<code>`.
   */
  pairing: adminProcedure
    .input(z.object({ tokenId: z.string().min(1), regenerate: z.boolean().default(false) }))
    .mutation(({ input }) => {
      try {
        return tokenService.pairing(input.tokenId, input.regenerate);
      } catch (err) {
        if (err instanceof TokenNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        if (err instanceof SharedTokenRevokeError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The shared token cannot be paired. Copy it from settings.json.",
          });
        }
        throw err;
      }
    }),

  /**
   * The addresses a pairing link may use: `BAND_PUBLIC_URL`, this machine's network interfaces
   * (Tailscale, IPv4, IPv6, then bridges) and the custom addresses saved in settings. Read on
   * every call, so Refresh sees a network that changed.
   */
  pairingAddresses: adminProcedure.query(() => pairingAddressService.list()),

  /** Saves a custom address (an http(s) origin). It is not probed: the hub can't tell what another device reaches. */
  addPairingAddress: adminProcedure
    .input(z.object({ url: z.string().trim().min(1).max(300) }))
    .mutation(({ input }) => {
      try {
        return pairingAddressService.add(input.url);
      } catch (err) {
        if (err instanceof InvalidPairingAddressError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  removePairingAddress: adminProcedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(({ input }) => pairingAddressService.remove(input.url)),

  issueWorkerBootstrap: adminProcedure
    .input(
      z.object({
        hostName: label,
        // A fixed id for the host, for a harness that must know it before the worker starts.
        // Without one the hub makes `h-<12 hex>`. A used id is refused.
        hostId: z
          .string()
          .regex(/^h-[a-z0-9][a-z0-9-]{0,39}$/)
          .optional(),
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
        input.hostId,
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
