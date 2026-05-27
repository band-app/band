import { z } from "zod";
import { settingsService } from "../../services/settings-service";
import { publicProcedure, t } from "../trpc";

/**
 * Settings sub-router — first migrated procedure under the new 3-tier
 * architecture (`docs/web-architecture.md`). Subsequent phases will move
 * other domains (projects, workspaces, chats, …) into sibling
 * `api/<domain>/router.ts` files following this same shape.
 *
 * The router is intentionally thin: it validates input with Zod, delegates
 * to `SettingsService`, and returns. No business logic lives here.
 */

export const settingsRouter = t.router({
  get: publicProcedure.query(() => {
    return settingsService.get();
  }),

  update: publicProcedure.input(z.record(z.string(), z.unknown())).mutation(({ input }) => {
    settingsService.update(input);
    return { ok: true };
  }),
});

export type SettingsRouter = typeof settingsRouter;
