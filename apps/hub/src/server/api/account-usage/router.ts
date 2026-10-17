import { z } from "zod";

import { listAccountUsage } from "../../services/account-usage-service";
import { publicProcedure, t } from "../trpc";

/**
 * Usage limits of the Claude and Codex accounts logged in on any online host,
 * for the sidebar's usage popover. The answer holds percentages, reset times,
 * plans and a display identity, never a token. The MCP endpoint leaves it out.
 */
export const accountUsageRouter = t.router({
  list: publicProcedure
    .input(z.object({ refresh: z.boolean().optional() }).default({}))
    .query(({ input }) => listAccountUsage({ refresh: input.refresh })),
});

export type AccountUsageRouter = typeof accountUsageRouter;
