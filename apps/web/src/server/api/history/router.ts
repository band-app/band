import { z } from "zod";
import {
  browserHistoryService,
  type ClearRange,
} from "../../services/browser-history-service";
import { publicProcedure, t } from "../trpc";

/**
 * Browser-history sub-router — migrated out of the legacy
 * `apps/web/src/trpc/router.ts` as part of Phase 8 (issue #319).
 *
 * Persistent per-workspace visit log. Surfaced as `trpc.history.*` and
 * consumed by:
 *   - `BrowserPanel` listeners — call `record` on each committed
 *     navigation and `updateMeta` when `page-title-updated` fires.
 *   - `useBrowserPaneControls` — calls `search` to drive address-bar
 *     autocomplete.
 *   - `HistoryPopover` — calls `list` / `search` / `delete` / `clear`.
 *
 * Visits are upserted on (workspaceId, url) — see the dedupe / frecency
 * rules in `infra/db/queries/browser-history.ts`. The router goes
 * through `services/browser-history-service.ts` so the API tier never
 * imports infra directly.
 */

const clearRangeSchema = z.enum(["hour", "day", "week", "all"]);

// Caps on the size of strings we persist. No real navigable URL is
// longer than 2048 chars (browsers historically cap somewhere
// between 2 KB and 8 KB; 2048 is the conservative web-server
// default). Titles can be longer in theory but we'd never display
// more than a few hundred chars. faviconUrl is normally just an
// origin + `/favicon.ico`. These caps protect against a misbehaving
// renderer inflating the DB with megabyte-sized `data:` URIs.
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1024;

// Whitelist of URL schemes accepted for `faviconUrl`. The rendered
// `<img src={faviconUrl}>` in `HistoryPopover` /
// `AddressBarAutocomplete` would otherwise execute any scheme the
// renderer dreamt up — `data:image/...;base64,...` URIs would
// inflate the DB, and `javascript:` would be a renderer XSS vector
// (though the renderer is trusted; defence in depth still). Real
// favicons are always http(s) origin-relative.
const ALLOWED_FAVICON_SCHEMES = ["http:", "https:"] as const;
const faviconUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine(
    (val) => {
      try {
        return ALLOWED_FAVICON_SCHEMES.includes(
          new URL(val).protocol as (typeof ALLOWED_FAVICON_SCHEMES)[number],
        );
      } catch {
        return false;
      }
    },
    { message: "faviconUrl must be a http(s) URL" },
  );

export const historyRouter = t.router({
  record: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        url: z.string().min(1).max(MAX_URL_LENGTH),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        faviconUrl: faviconUrlSchema.optional(),
      }),
    )
    .mutation(({ input }) => {
      const recorded = browserHistoryService.recordVisit({
        workspaceId: input.workspaceId,
        url: input.url,
        title: input.title,
        faviconUrl: input.faviconUrl,
      });
      return { ok: true, recorded };
    }),

  updateMeta: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        url: z.string().min(1).max(MAX_URL_LENGTH),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        faviconUrl: faviconUrlSchema.optional(),
      }),
    )
    .mutation(({ input }) => {
      browserHistoryService.updateVisitMeta({
        workspaceId: input.workspaceId,
        url: input.url,
        title: input.title,
        faviconUrl: input.faviconUrl,
      });
      return { ok: true };
    }),

  list: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(({ input }) => {
      const entries = browserHistoryService.listHistory(input.workspaceId, {
        limit: input.limit,
        offset: input.offset,
      });
      return { entries };
    }),

  search: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(({ input }) => {
      const entries = browserHistoryService.searchHistory(
        input.workspaceId,
        input.query,
        input.limit ?? 8,
      );
      return { entries };
    }),

  delete: publicProcedure
    // `positive()` rather than `nonnegative()` — autoincrement ids
    // start at 1. `workspaceId` scopes the delete so a caller that
    // knows a row id from a *different* workspace can't reach into
    // it.
    .input(z.object({ id: z.number().int().positive(), workspaceId: z.string().min(1) }))
    .mutation(({ input }) => {
      browserHistoryService.deleteHistoryEntry(input.id, input.workspaceId);
      return { ok: true };
    }),

  clear: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        range: clearRangeSchema,
      }),
    )
    .mutation(({ input }) => {
      const deleted = browserHistoryService.clearHistory(
        input.workspaceId,
        input.range satisfies ClearRange,
      );
      return { deleted };
    }),
});

export type HistoryRouter = typeof historyRouter;
