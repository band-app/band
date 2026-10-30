import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { simulatorService } from "../../services/simulator-service";
import { publicProcedure, t } from "../trpc";

const input = z.object({ worktreeId: z.string().min(1) });

/**
 * A worktree's iOS simulator for the Simulator tab (the `simulator` plugin, `docs/simulator.md`).
 * The live screen is the WebSocket route `/api/plugins/simulator/worktrees/<id>/stream`. These
 * procedures are a person's: the MCP endpoint and the worker relay leave them out, and an agent
 * uses the `simulator_*` tools.
 */
export const simulatorsRouter = t.router({
  /** Whether the worktree's worker can run a simulator, and the device's state when it can. */
  status: publicProcedure.input(input).query(async ({ input: { worktreeId } }) => {
    return simulatorService.status(worktreeId).catch((err: unknown) => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }),

  /**
   * Boots the worktree's simulator and adds the Simulator tab to the worktree's shared tab list,
   * which every connected client then opens.
   */
  open: publicProcedure.input(input).mutation(async ({ input: { worktreeId } }) => {
    return simulatorService.open(worktreeId).catch((err: unknown) => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }),
});

export type SimulatorsRouter = typeof simulatorsRouter;
