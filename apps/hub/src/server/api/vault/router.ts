/**
 * `vault.*`: credentials the hub holds (plan step 4.1). Every procedure needs
 * an admin device token (403 otherwise). No procedure returns a secret: `put`
 * takes one, and `list` shows metadata only. The MCP endpoint and the worker
 * relay leave the whole router out, so an agent cannot read, add or connect
 * credentials.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { VaultInputError, VaultNotFoundError } from "../../errors";
import { MAX_SECRET_LENGTH, vaultService } from "../../services/vault-service";
import { adminProcedure, t } from "../trpc";

const scope = z.string().default("global");
const name = z.string().trim().min(1).max(100);

function mapError(err: unknown): never {
  if (err instanceof VaultNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  if (err instanceof VaultInputError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
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

export const vaultRouter = t.router({
  list: adminProcedure.query(() => ({
    items: vaultService.list(),
    keySource: vaultService.keySource(),
  })),

  put: adminProcedure
    .input(
      z.object({
        name,
        kind: z.enum(["api_key", "env"]).default("api_key"),
        scope,
        value: z.string().min(1).max(MAX_SECRET_LENGTH),
        description: z.string().max(200).optional(),
      }),
    )
    .mutation(({ input }) => guard(() => ({ item: vaultService.put(input) }))),

  delete: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => guard(() => vaultService.remove(input.id))),

  rotateKey: adminProcedure.mutation(() => guard(() => vaultService.rotateKey())),

  startOAuth: adminProcedure
    .input(
      z.object({
        name,
        serverUrl: z.string().url(),
        scope,
        scopes: z.string().max(500).optional(),
        clientId: z.string().min(1).max(500).optional(),
        clientSecret: z.string().min(1).max(2000).optional(),
        redirectBase: z.string().url().optional(),
      }),
    )
    .mutation(({ input }) => guard(() => vaultService.startOAuth(input))),

  oauthStatus: adminProcedure
    .input(z.object({ flowId: z.string().min(1) }))
    .query(({ input }) => guard(() => vaultService.oauthStatus(input.flowId))),
});
