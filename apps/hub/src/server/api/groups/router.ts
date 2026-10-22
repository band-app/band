/**
 * `groups.*`: worktree groups. Anyone with a device token may list them. Creating, renaming,
 * recoloring, reordering and deleting are left out of the MCP endpoint and the worker relay, so an
 * agent can assign worktrees to a group (`worktrees.setGroup`) but not change the groups.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { WorktreeGroupNotFoundError } from "../../errors";
import { worktreeGroupService } from "../../services/worktree-group-service";
import { publicProcedure, t } from "../trpc";

const groupName = z.string().trim().min(1).max(100);
const groupColor = z.string().trim().min(1).max(64);

function rethrow(err: unknown): never {
  if (err instanceof WorktreeGroupNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}

export const groupsRouter = t.router({
  list: publicProcedure.query(() => ({ groups: worktreeGroupService.list() })),

  create: publicProcedure
    .input(z.object({ name: groupName, color: groupColor.optional() }))
    .mutation(({ input }) => ({ group: worktreeGroupService.create(input) })),

  update: publicProcedure
    .input(z.object({ id: z.string(), name: groupName.optional(), color: groupColor.optional() }))
    .mutation(({ input }) => {
      try {
        const { id, ...patch } = input;
        return { group: worktreeGroupService.update(id, patch) };
      } catch (err) {
        rethrow(err);
      }
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    try {
      worktreeGroupService.remove(input.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }),

  reorder: publicProcedure
    .input(z.object({ ids: z.array(z.string()).min(1).max(500) }))
    .mutation(({ input }) => {
      try {
        worktreeGroupService.reorder(input.ids);
        return { ok: true };
      } catch (err) {
        rethrow(err);
      }
    }),
});
