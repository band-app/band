import { settingsService, settingsUpdateInput } from "../../services/settings-service";
import { publicProcedure, t } from "../trpc";

/**
 * Settings sub-router — first migrated procedure under the new 3-tier
 * architecture (`docs/web-architecture.md`). Subsequent phases will move
 * other domains (projects, workspaces, chats, …) into sibling
 * `api/<domain>/router.ts` files following this same shape.
 *
 * The router is intentionally thin: it validates input with Zod, delegates
 * to `SettingsService`, and returns. No business logic lives here.
 *
 * The `settingsUpdateInput` schema is defined in the service tier so the
 * router and `SettingsService.update` share a single source of truth — see
 * `services/settings-service.ts` for the schema and rationale.
 */

export const settingsRouter = t.router({
  get: publicProcedure.query(() => {
    return settingsService.get();
  }),

  update: publicProcedure.input(settingsUpdateInput).mutation(({ input }) => {
    settingsService.update(input);
    return { ok: true };
  }),
});

export type SettingsRouter = typeof settingsRouter;
