import { z } from "zod";
import { modelRefreshService } from "../../services/model-refresh-service";
import { loadSettings } from "../../services/state";
import { publicProcedure, t } from "../trpc";

/**
 * Models sub-router — issue #517's pass-through to `listModels()` evolved
 * into a settings-backed cache (issue: refresh-agent-models). Reads go
 * through `ModelRefreshService.getCachedOrDefaults` (settings.json cache
 * with adapter-default fallback), so the chat picker and Settings UI are
 * always populated — even on a fresh chat with no session yet.
 *
 * Writes go through `modelRefreshService.refresh()`, which calls the
 * adapter's `refreshModels()` (live SDK fetch where applicable) and
 * persists the result back into `settings.codingAgents[].cachedModels`.
 */
export const modelsRouter = t.router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .query(({ input }) => modelRefreshService.listForAgent(input.agentId)),

  /** List all agents with their cached models — used by the combined
   *  agent/model selector in the chat UI. Loads settings.json exactly
   *  once and threads the snapshot through to the service so the read
   *  path stays at one fs hit per query. */
  listAll: publicProcedure.query(async () => {
    const settings = loadSettings();
    const codingAgents = settings.codingAgents ?? [];
    const defaultAgentId = settings.defaultCodingAgent ?? codingAgents[0]?.id ?? "";
    const agents = await modelRefreshService.getAllCachedOrDefaultsFromSnapshot(settings);
    return { agents, defaultAgentId };
  }),

  /**
   * Refresh the cached model list for the given agent (or every
   * configured agent when `agentId` is omitted). Surfaces the live SDK
   * list to the persisted cache so subsequent `list` / `listAll` calls
   * return the latest models. Failures on individual agents do not
   * abort the batch — each result carries an optional `error` field.
   */
  refresh: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .mutation(async ({ input }) => {
      if (input.agentId) {
        const result = await modelRefreshService.refresh(input.agentId);
        return { results: [result] };
      }
      const results = await modelRefreshService.refreshAll();
      return { results };
    }),
});

export type ModelsRouter = typeof modelsRouter;
