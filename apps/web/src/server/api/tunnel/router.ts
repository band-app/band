import { createLogger } from "@band-app/logger";
import { z } from "zod";
import { tunnelService } from "../../services/tunnel-service";
import { publicProcedure, t } from "../trpc";

const log = createLogger("trpc.tunnel");

/**
 * Tunnel sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Procedures are intentionally thin: validate with
 * Zod, delegate to `TunnelService`, return.
 *
 * The wire shape (`tunnel.status` / `tunnel.start` / `tunnel.stop`) is
 * preserved exactly. The router used to live inline in
 * `apps/web/src/trpc/router.ts`.
 */
export const tunnelRouter = t.router({
  status: publicProcedure.query(() => {
    return tunnelService.getStatus();
  }),

  start: publicProcedure.input(z.object({}).optional()).mutation(async () => {
    log.debug("tunnel.start called");
    try {
      await tunnelService.start();
    } catch (err) {
      log.debug({ err }, "tunnel.start: startTunnel failed");
      return { ok: true, url: null as string | null };
    }
    const status = tunnelService.getStatus();
    log.debug({ status }, "tunnel.start: after startTunnel");
    if (status.url) {
      return { ok: true, url: status.url };
    }
    log.debug("tunnel.start: no URL available");
    return { ok: true, url: null as string | null };
  }),

  stop: publicProcedure.mutation(async () => {
    await tunnelService.stop();
    return { ok: true };
  }),
});

export type TunnelRouter = typeof tunnelRouter;
