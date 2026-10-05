/**
 * `runners.*`: the configured runner hooks and what they are doing (plan step
 * 3.4, snapshots 3.10). Admin tokens only; `destroyMachine` destroys a machine a runner started. A runner is configured in `settings.json` (`runners`), and
 * the hub runs them itself. The MCP endpoint and the worker relay leave this
 * router out, like `hosts.*`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { MachineError, runnerReaperService } from "../../services/runner-reaper-service";
import { runnerService } from "../../services/runner-service";
import { adminProcedure, t } from "../trpc";

export const runnersRouter = t.router({
  list: adminProcedure.query(() => ({
    ...runnerService.runners(),
    runs: runnerService.runs(),
  })),

  /** The machine snapshots the hub holds, newest first (plan step 3.10). */
  snapshots: adminProcedure.query(() => ({
    snapshots: runnerService.snapshotList().map((s) => ({
      id: s.id,
      runnerId: s.runnerId,
      hostId: s.hostId,
      workspaceIds: s.workspaceIds,
      snapshotId: s.snapshotId,
      sizeBytes: s.sizeBytes,
      restoredAt: s.restoredAt,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    })),
  })),

  /** The hook output of a host request, as the hub logged it (tokens removed). */
  log: adminProcedure
    .input(z.object({ requestId: z.string().min(1).max(100) }))
    .query(({ input }) => ({ log: runnerService.readLog(input.requestId) })),

  /** The machines the runners started, newest first, with the state the reaper keeps them in. */
  machines: adminProcedure.query(() => ({ machines: runnerReaperService.list() })),

  /**
   * Destroys a machine now. A machine holding workspaces that are not stored is refused unless
   * `force` is set.
   */
  destroyMachine: adminProcedure
    .input(z.object({ id: z.string().min(1).max(100), force: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      try {
        return await runnerReaperService.destroy(input.id, { force: input.force });
      } catch (err) {
        if (err instanceof MachineError) {
          throw new TRPCError({
            code: err.reason === "not-found" ? "NOT_FOUND" : "CONFLICT",
            message: err.message,
          });
        }
        throw err;
      }
    }),
});
