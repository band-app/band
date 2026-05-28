/**
 * Browsers sub-routers — migrated out of the legacy `apps/web/src/trpc/router.ts`
 * in issue #316 (Phase 5 of the 3-tier refactor described in
 * `docs/web-architecture.md`).
 *
 * The router is intentionally thin: it validates input with Zod, delegates
 * to `BrowserService` (and `watcher.emit` for lifecycle events), and
 * returns. No business logic lives here.
 *
 * Two sub-routers are exported:
 *   - `browsersRouter` covers the per-tab CRUD lifecycle at the
 *     `browsers.*` tRPC namespace.
 *   - `browserLayoutRouter` covers the saved dockview layout tree at the
 *     `browserLayout.*` tRPC namespace.
 *
 * Both are merged into the root router by `server/api/router.ts`. The
 * `browserHost.*` namespace and the `history.*` namespace remain in the
 * legacy router until their own refactor phases — both live in `lib/` and
 * touch the desktop IPC bridge / a dedicated history table that aren't
 * part of the chats/browsers domain.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { browserService } from "../../services/browser-service";
import { emit } from "../../services/watcher";
import { publicProcedure, t } from "../trpc";

// ---------------------------------------------------------------------------
// Browser Layout (split pane tree persistence)
// ---------------------------------------------------------------------------

export const browserLayoutRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { tree: browserService.getLayout(input.workspaceId) };
  }),

  save: publicProcedure
    .input(z.object({ workspaceId: z.string(), tree: z.unknown() }))
    .mutation(({ input }) => {
      browserService.saveLayout(input.workspaceId, input.tree);
      return { ok: true };
    }),
});

export type BrowserLayoutRouter = typeof browserLayoutRouter;

// ---------------------------------------------------------------------------
// Browsers (multi-tab browser management)
// ---------------------------------------------------------------------------

export const browsersRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { browsers: browserService.list(input.workspaceId) };
  }),

  create: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      // `browserService.create` also registers the tab in the saved
      // dockview layout — see `chatService.create` for the same pattern.
      const browser = browserService.create(input.workspaceId, {
        id: input.id,
        name: input.name,
        url: input.url,
      });
      emit({ kind: "browser-created", workspaceId: input.workspaceId, browserId: browser.id });
      return { browser };
    }),

  get: publicProcedure.input(z.object({ browserId: z.string() })).query(({ input }) => {
    const browser = browserService.get(input.browserId);
    return { browser: browser ?? null };
  }),

  update: publicProcedure
    .input(
      z.object({
        browserId: z.string(),
        name: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { browserId, ...updates } = input;
      const browser = browserService.update(browserId, updates);
      if (!browser) {
        // Mirror the 404 contract `chats.update` adopted in issue #520:
        // returning `200 { browser: undefined }` would let a caller treat a
        // typo'd browserId as a successful no-op rather than surfacing the
        // stale id. Existing UI callers wrap the mutation in `.catch`, so
        // the new 404 is absorbed the same way the silent 200 was.
        throw new TRPCError({ code: "NOT_FOUND", message: "Browser not found" });
      }
      return { browser };
    }),

  navigate: publicProcedure
    .input(z.object({ browserId: z.string(), url: z.string() }))
    .mutation(({ input }) => {
      browserService.updateUrl(input.browserId, input.url);
      return { ok: true };
    }),

  remove: publicProcedure.input(z.object({ browserId: z.string() })).mutation(({ input }) => {
    // `browserService.remove` handles DB + layout + in-memory cleanup in
    // one call (mirrors `chatService.remove`) and returns the removed tab
    // so we can carry its `workspaceId` into the lifecycle event without
    // a pre-remove `get()` — a separate read would race with concurrent
    // deletes and could surface `workspaceId: undefined` on the event.
    const removed = browserService.remove(input.browserId);
    emit({
      kind: "browser-removed",
      workspaceId: removed === false ? undefined : removed.workspaceId,
      browserId: input.browserId,
    });
    return { ok: true };
  }),
});

export type BrowsersRouter = typeof browsersRouter;
