import { z } from "zod";
import { agentService } from "../../services/agent-service";
import { getAgentDefinition, loadSettings } from "../../services/state";
import { publicProcedure, t } from "../trpc";

/**
 * Models sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Returns the list of models the named agent
 * exposes plus the default model configured in Band's settings.
 *
 * `list` is a pass-through to the agent's `listModels()` method via a
 * metadata-only agent instance from the pool, plus a settings lookup for
 * the configured default. `listAll` fans out across every configured
 * coding agent — used by the combined agent/model selector in the UI.
 */
export const modelsRouter = t.router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .query(async ({ input }) => {
      const agent = await agentService.createMetadataAgent(input.agentId);
      const models = agent.listModels ? await agent.listModels() : [];
      // Include the agent's configured default model from Band settings.
      const settings = loadSettings();
      const agentDef = getAgentDefinition(settings, input.agentId);
      return { models, defaultModel: agentDef.model };
    }),

  /** List all agents with their models — used by the combined agent/model selector. */
  listAll: publicProcedure.query(async () => {
    const settings = loadSettings();
    const codingAgents = settings.codingAgents ?? [];
    const defaultAgentId = settings.defaultCodingAgent ?? codingAgents[0]?.id ?? "";

    const agents = await Promise.all(
      codingAgents.map(async (def) => {
        try {
          const agent = await agentService.createMetadataAgent(def.id);
          const models = agent.listModels ? await agent.listModels() : [];
          return {
            agentId: def.id,
            agentType: def.type,
            agentLabel: def.label,
            models,
            defaultModel: def.model,
          };
        } catch {
          return {
            agentId: def.id,
            agentType: def.type,
            agentLabel: def.label,
            models: [],
            defaultModel: def.model,
          };
        }
      }),
    );

    return { agents, defaultAgentId };
  }),
});

export type ModelsRouter = typeof modelsRouter;
