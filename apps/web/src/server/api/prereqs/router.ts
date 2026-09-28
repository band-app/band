import { systemService } from "../../services/system-service";
import { publicProcedure, t } from "../trpc";

/**
 * Prereqs sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Exposes host-level prerequisite checks (the
 * cloudflared CLI) and the brew-driven installer that backs the dashboard's
 * "Install Tunnel" button. Both procedures delegate to `SystemService`;
 * the router does no infra work of its own.
 */
export const prereqsRouter = t.router({
  check: publicProcedure.query(async () => {
    return await systemService.checkPrereqs();
  }),

  installTunnel: publicProcedure.mutation(async () => {
    const resolvedPath = await systemService.shellPath();
    await systemService.installCloudflared(resolvedPath);
    return { ok: true };
  }),
});

export type PrereqsRouter = typeof prereqsRouter;
