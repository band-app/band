import { z } from "zod";
import { checkHooks, installHooks, listHostHooks, removeHooks } from "../../services/hooks-service";
import { adminProcedure, t } from "../trpc";

/**
 * Manages the `band notify` hooks Band registers in a host's
 * `~/.claude/settings.json`. Every call names a host (the hub's own machine
 * when `hostId` is left out), and nothing installs unless one of these is
 * called. The calls change files on a machine, so they need an admin token.
 */
const hostInput = z.object({ hostId: z.string().optional() }).default({});

function failure(err: unknown): Error {
  return new Error(err instanceof Error ? err.message : String(err));
}

export const hooksRouter = t.router({
  /** The hub's own host. */
  check: adminProcedure.input(hostInput).query(async ({ input }) => {
    return await checkHooks(input.hostId);
  }),

  /** Every host with its hooks status. */
  hosts: adminProcedure.query(async () => ({ hosts: await listHostHooks() })),

  install: adminProcedure.input(hostInput).mutation(async ({ input }) => {
    try {
      await installHooks(input.hostId);
      return { ok: true };
    } catch (err) {
      throw failure(err);
    }
  }),

  /** Removes Band's entries and leaves every other hook and setting. */
  remove: adminProcedure.input(hostInput).mutation(async ({ input }) => {
    try {
      await removeHooks(input.hostId);
      return { ok: true };
    } catch (err) {
      throw failure(err);
    }
  }),
});

export type HooksRouter = typeof hooksRouter;
