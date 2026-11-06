import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { listResources, resourceStorage } from "../../services/resources-service";
import { publicProcedure, t } from "../trpc";

/**
 * The Resources page: memory and CPU of the hub's machine and of every online worker, and disk
 * use measured on the machine that holds the files. The MCP endpoint and the worker relay leave
 * it out, so an agent cannot read the machine's process table through it.
 */
export const resourcesRouter = t.router({
  snapshot: publicProcedure.query(() => listResources()),
  storage: publicProcedure
    .input(z.object({ hostId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await resourceStorage(input.hostId);
      } catch (err) {
        console.error(`[resources] storage on ${input.hostId} failed:`, err);
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: `Could not measure storage on ${input.hostId}`,
        });
      }
    }),
});

export type ResourcesRouter = typeof resourcesRouter;
