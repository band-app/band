/**
 * `agentLogins.*`: Band-managed logins for coding agents. Every
 * procedure needs an admin device token (403 otherwise). `create` and `update` take a secret and
 * write it to the vault, and no procedure returns one. The MCP endpoint and the worker relay leave
 * the whole router out, so an agent cannot read or change a login.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { AgentLoginInputError, AgentLoginNotFoundError, VaultInputError } from "../../errors";
import { agentLoginService } from "../../services/agent-login-service";
import { adminProcedure, t } from "../trpc";

const agentType = z.string().trim().min(1).max(50);
const loginId = z.string().min(1).max(50);

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AgentLoginNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (err instanceof AgentLoginInputError || err instanceof VaultInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

export const agentLoginsRouter = t.router({
  list: adminProcedure.query(() => agentLoginService.list()),

  create: adminProcedure
    .input(
      z.object({
        agentType,
        kind: z.string().trim().min(1).max(50),
        label: z.string().max(200),
        secret: z
          .string()
          .min(1)
          .max(16 * 1024)
          .optional(),
        vaultItemId: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(({ input }) => guard(() => ({ login: agentLoginService.create(input) }))),

  update: adminProcedure
    .input(
      z.object({
        id: loginId,
        label: z.string().max(200).optional(),
        secret: z
          .string()
          .min(1)
          .max(16 * 1024)
          .optional(),
      }),
    )
    .mutation(({ input }) => guard(() => ({ login: agentLoginService.update(input) }))),

  remove: adminProcedure
    .input(z.object({ id: loginId }))
    .mutation(({ input }) => guard(() => agentLoginService.remove(input.id))),

  setDefault: adminProcedure
    .input(z.object({ agentType, loginId: loginId.nullable() }))
    .mutation(({ input }) =>
      guard(() => {
        agentLoginService.setDefault(input.agentType, input.loginId);
        return { ok: true as const };
      }),
    ),

  setRepoOverride: adminProcedure
    .input(
      z.object({ agentType, repo: z.string().trim().min(1).max(100), loginId: loginId.nullable() }),
    )
    .mutation(({ input }) =>
      guard(() => {
        agentLoginService.setRepoOverride(input.agentType, input.repo, input.loginId);
        return { ok: true as const };
      }),
    ),
});
