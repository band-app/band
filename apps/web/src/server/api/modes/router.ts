import { z } from "zod";
import { createMetadataAgent } from "../../services/agent-service";
import { publicProcedure, t } from "../trpc";

/**
 * Modes sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Returns the list of agent execution modes
 * (e.g. Claude Code's `plan` / `accept-all`) for the named agent
 * definition.
 *
 * Pass-through to the agent's `listModes()` method via a metadata-only
 * agent instance from the pool. No DB state, no business logic — just a
 * thin tRPC wrapper around an agent capability.
 */
export const modesRouter = t.router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .query(async ({ input }) => {
      const agent = await createMetadataAgent(input.agentId);
      if (agent.listModes) {
        return { modes: agent.listModes() };
      }
      return { modes: [] };
    }),
});

export type ModesRouter = typeof modesRouter;
