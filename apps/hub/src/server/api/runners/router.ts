/**
 * `runners.*`: the configured runner hooks and what they are doing (plan step
 * 3.4), and the machine snapshots they took (3.10). Read-only, admin tokens only. A runner is configured in `settings.json` (`runners`), and
 * the hub runs them itself. The MCP endpoint and the worker relay leave this
 * router out, like `hosts.*`.
 */

import { z } from "zod";
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
});
