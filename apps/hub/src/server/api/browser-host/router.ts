import { createLogger } from "@band-app/logger";
import { z } from "zod";
import { browserHostService, type EnsureViewEvent } from "../../services/browser-host-service";
import { publicProcedure, t } from "../trpc";

const log = createLogger("trpc.browser-host");

/**
 * Browser host + host file-access routers — migrated into the 3-tier
 * architecture as part of Phase 7.5 (issue #517).
 *
 * `browserHostRouter` — bridge between the web server and the
 *     desktop's BrowserGuestManager. See the docstring on
 *     `server/infra/browser-host/host-state.ts` for the full ensure/destroy
 *     protocol; the `BrowserHostService` wrapper in services/ keeps the
 *     router from importing infra directly.
 *
 * External files (paths outside any worktree) go through
 * `worktree.readExternalFile` / `saveExternalFile`, which use the worktree's
 * own worker. The old `host.readFile` / `host.saveFile` read the hub's disk
 * and are gone.
 */

export const browserHostRouter = t.router({
  // Diagnostic: the desktop's BrowserHostBridge calls this on mount so we
  // can confirm in the server log that the bridge component actually
  // executed. Drop once the experiment is stable.
  ping: publicProcedure.input(z.object({ where: z.string() })).mutation(({ input }) => {
    log.info("browserHost.ping from %s", input.where);
    return { ok: true };
  }),

  ensureView: publicProcedure.subscription(async function* (opts) {
    const queue: EnsureViewEvent[] = [];
    let resolve: (() => void) | null = null;

    const unsubscribe = browserHostService.onEnsureView((event) => {
      queue.push(event);
      resolve?.();
    });

    opts.signal?.addEventListener("abort", () => {
      unsubscribe();
      resolve?.();
    });

    try {
      while (!opts.signal?.aborted) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
      }
    } finally {
      unsubscribe();
    }
  }),

  targetReady: publicProcedure
    .input(z.object({ bandTabId: z.string(), cdpTargetId: z.string() }))
    .mutation(({ input }) => {
      browserHostService.resolveTargetReady(input.bandTabId, input.cdpTargetId);
      return { ok: true };
    }),

  viewDestroyed: publicProcedure
    .input(z.object({ bandTabId: z.string() }))
    .mutation(({ input }) => {
      browserHostService.markTargetDestroyed(input.bandTabId);
      return { ok: true };
    }),
});

export type BrowserHostRouter = typeof browserHostRouter;
