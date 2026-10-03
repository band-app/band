import { checkHooks, installHooks } from "../../services/hooks-service";
import { publicProcedure, t } from "../trpc";

/**
 * Hooks sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Manages the `band notify` hooks Band registers in
 * `~/.claude/settings.json` so the Claude Code agent fires the dashboard's
 * notifications.
 *
 * The router is intentionally thin: the actual `~/.claude/settings.json`
 * read/write lives in `services/hooks.ts` (absorbed from `lib/hooks.ts`).
 */
export const hooksRouter = t.router({
  check: publicProcedure.query(async () => {
    return await checkHooks();
  }),

  install: publicProcedure.mutation(async () => {
    try {
      await installHooks();
      return { ok: true };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }),
});

export type HooksRouter = typeof hooksRouter;
