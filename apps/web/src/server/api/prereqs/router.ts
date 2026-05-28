import { execFile } from "node:child_process";
import { systemService } from "../../services/system-service";
import { publicProcedure, t } from "../trpc";

/**
 * Prereqs sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Exposes host-level prerequisite checks (the
 * cloudflared CLI) and the brew-driven installer that backs the dashboard's
 * "Install Tunnel" button.
 *
 * `installTunnel` shells out to `brew install cloudflared` directly here
 * rather than living on a service — it's a one-shot administrative action
 * driven by the user clicking a button, with no orchestration beyond
 * "spawn brew and wait." Moving it to the service layer would just be
 * indirection for indirection's sake.
 */
export const prereqsRouter = t.router({
  check: publicProcedure.query(async () => {
    return await systemService.checkPrereqs();
  }),

  installTunnel: publicProcedure.mutation(async () => {
    const resolvedPath = await systemService.shellPath();
    await new Promise<void>((resolve, reject) => {
      execFile(
        "brew",
        ["install", "cloudflared"],
        { env: { ...process.env, PATH: resolvedPath }, timeout: 120_000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
            return;
          }
          resolve();
        },
      );
    });
    return { ok: true };
  }),
});

export type PrereqsRouter = typeof prereqsRouter;
