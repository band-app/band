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

/**
 * Schema for the known top-level keys of `~/.band/settings.json` (mirrors the
 * fields modeled on `Settings` in `server/infra/db/queries/settings.ts`).
 *
 * `.passthrough()` is deliberate: the settings document is a forward-compat
 * JSON file that the desktop shell and future client versions may write
 * additional keys into. Rejecting unknown keys here would corrupt the file
 * on the next `update` round-trip from an older client. The known-key
 * schema still narrows the common write paths — typos in keys the dashboard
 * UI controls today (`enableLSP`, `theme`, `worktreesDir`, etc.) are caught
 * by Zod instead of silently persisting garbage. The `Settings` interface
 * uses an `[key: string]: unknown` index signature for the same reason.
 */
const settingsUpdateInput = z
  .object({
    // `null` is allowed because the dashboard sends `worktreesDir.trim() || null`
    // when the field is cleared — the legacy behavior preserved across the
    // 3-tier migration.
    worktreesDir: z.string().nullish(),
    codingAgents: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          label: z.string(),
          command: z.string().optional(),
          model: z.string().optional(),
        }),
      )
      .optional(),
    defaultCodingAgent: z.string().optional(),
    webServerPort: z.number().optional(),
    notifications: z
      .object({
        soundOnNeedsAttention: z.boolean().optional(),
        sound: z.string().optional(),
      })
      .optional(),
    labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })).optional(),
    tokenSecret: z.string().optional(),
    autoStartTunnel: z.boolean().optional(),
    maxCachedWorkspaces: z.number().optional(),
    claudeCodePartialMessages: z.boolean().optional(),
  })
  .passthrough();

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
