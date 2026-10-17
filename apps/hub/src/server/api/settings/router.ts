import { TRPCError } from "@trpc/server";

import { settingsService, settingsUpdateInput } from "../../services/settings-service";
import { publicProcedure, t } from "../trpc";

/**
 * Settings sub-router — first migrated procedure under the new 3-tier
 * architecture (`docs/web-architecture.md`). Subsequent phases will move
 * other domains (repos, worktrees, chats, …) into sibling
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
  get: publicProcedure.query(({ ctx }) => {
    // The shared token secret is an admin credential, so no caller gets it back.
    // The voice endpoint (URL, host, key item) is for admins; other devices use voice.status.
    const { tokenSecret: _tokenSecret, voice, ...settings } = settingsService.get();
    return ctx.admin ? { ...settings, voice } : settings;
  }),

  update: publicProcedure.input(settingsUpdateInput).mutation(({ input, ctx }) => {
    // The builder host, registry and worker image decide where repository
    // commands run and where images go, and runners are programs the hub
    // executes, so only an admin token may change them.
    if (input.environmentBuilder !== undefined && !ctx.admin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Changing environmentBuilder needs an admin token.",
      });
    }
    if (input.voice !== undefined && !ctx.admin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Changing voice needs an admin token.",
      });
    }
    if (input.runners !== undefined && !ctx.admin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Changing runners needs an admin token.",
      });
    }
    if (input.tokenSecret !== undefined && !ctx.admin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Changing tokenSecret needs an admin token.",
      });
    }
    settingsService.update(input);
    return { ok: true };
  }),
});

export type SettingsRouter = typeof settingsRouter;
