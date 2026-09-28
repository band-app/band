import { z } from "zod";
import { modelRefreshService } from "../../services/model-refresh-service";
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
 *
 * Auth: these use `publicProcedure`, but "public" here means "no extra
 * per-procedure auth middleware" — every `/trpc/*` route (including the
 * `refresh` mutation, which spawns an agent subprocess) is gated by the
 * HTTP-layer `band_token` auth middleware. There is no unauthenticated
 * path to these procedures.
 */
export const modelsRouter = t.router({
  list: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .query(({ input }) => modelRefreshService.listForAgent(input.agentId)),

  /** List all agents with their cached models — used by the combined
   *  agent/model selector in the chat UI. The service loads settings.json
   *  once and resolves the effective default-agent id. */
  listAll: publicProcedure.query(() => modelRefreshService.listAllForPicker()),

  /**
   * Refresh the cached model list for the given agent (or every
   * configured agent when `agentId` is omitted). Surfaces the live SDK
   * list to the persisted cache so subsequent `list` / `listAll` calls
   * return the latest models. Failures on individual agents do not
   * abort the batch — each result carries an optional `error` field.
   *
   * Latency: this awaits the refresh synchronously. Each agent's
   * `refreshModels()` is capped at a ~10 s adapter-side timeout, and the
   * no-`agentId` batch path refreshes agents sequentially, so worst-case
   * wall-clock is roughly `N agents × 10 s`. The Settings UI only ever
   * calls this with a single `agentId` (one ~10 s ceiling, with a button
   * spinner), so the batch ceiling is reached only by an explicit
   * all-agents API call. Size any client-side tRPC timeout accordingly.
   *
   * If the supported-agent list ever grows past the current 5 entries
   * (claude-code, codex, gemini-cli, cursor-cli, opencode), reconsider:
   * (a) parallelising the per-agent loop in `refreshAll` (the only
   * thing that prevents it today is the `settings.json` RMW interleave,
   * which a single load-merge-save at the end would let us bypass), or
   * (b) flipping the batch path to fire-and-forget with an SSE notice
   * so the HTTP response returns immediately.
   */
  refresh: publicProcedure
    .input(z.object({ agentId: z.string().optional() }))
    .mutation(async ({ input }) => {
      const results = await modelRefreshService.refreshOneOrAll(input.agentId);
      return { results };
    }),
});

export type ModelsRouter = typeof modelsRouter;
