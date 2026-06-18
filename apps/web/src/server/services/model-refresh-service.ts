/**
 * Refresh the cached model list for each configured coding agent.
 *
 * The model list used to be fetched lazily inside `ClaudeCodeAdapter.runSession()`
 * and cached in-memory per-adapter-instance. That meant:
 *   1. A fresh chat pane saw no SDK-discovered models until the user sent
 *      their first message.
 *   2. The cache was lost on server restart.
 *   3. The Settings UI couldn't show the live list without first triggering
 *      a chat session.
 *
 * This service moves the cache into `~/.band/settings.json` (one entry per
 * `CodingAgentDefinition`) and exposes two refresh paths:
 *
 *   • **Boot-time fire-and-forget** — `runFirstTimeSetup` kicks off a
 *     `refreshAll()` after the rest of the setup pipeline. Failures (network,
 *     missing binary) log a warning and keep the prior cached list.
 *   • **Explicit user request** — the `models.refresh` tRPC mutation
 *     dispatches `refresh(agentId)` from the Settings UI's "Refresh models"
 *     button.
 *
 * Reads always go through the persisted cache (`getCachedOrDefaults`), which
 * falls back to the adapter's hardcoded defaults when no cache has been
 * written yet so a fresh install never shows an empty picker.
 *
 * The service is intentionally sequential — boot-time and user-initiated
 * refreshes share the same `~/.band/settings.json` file, and running two
 * `load → mutate → save` cycles in parallel would race (last writer wins).
 * The implementation `for await`s each agent rather than `Promise.all`-ing
 * them, even though the SDK calls themselves could overlap. The overhead is
 * negligible (one refresh call per agent, capped at ~5 entries).
 *
 * Snapshot-passing convention: every public method loads `settings.json` at
 * most once and threads the snapshot to internal helpers — see the
 * `*FromSnapshot` variants. Callers that already hold a snapshot (the
 * `models.list` / `models.listAll` tRPC handlers) should use the
 * snapshot-based helpers directly to avoid duplicate `readFileSync` calls.
 */

import type { AgentModel } from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import { createMetadataAgent } from "../infra/agents/agent-pool";
import type {
  CachedAgentModel,
  CodingAgentDefinition,
  Settings,
} from "../infra/db/queries/settings";
import { SettingsQueries } from "../infra/db/queries/settings";
import { SettingsService } from "./settings-service";

const log = createLogger("model-refresh");

/**
 * Adapter-pool seam — tests inject a stub that returns a fake
 * `CodingAgent` so the refresh path can be exercised without spawning
 * the real coding-agent SDK.
 */
export interface ModelRefreshPool {
  createMetadataAgent: typeof createMetadataAgent;
}

const DEFAULT_POOL: ModelRefreshPool = {
  createMetadataAgent,
};

export interface ModelRefreshResult {
  agentId: string;
  models: CachedAgentModel[];
  updatedAt: number;
  /** When refresh failed, the prior cached list (or the adapter defaults)
   *  is still returned and `error` is populated with the failure reason. */
  error?: string;
}

export class ModelRefreshService {
  constructor(
    private readonly queries: SettingsQueries = new SettingsQueries(),
    private readonly pool: ModelRefreshPool = DEFAULT_POOL,
  ) {}

  /**
   * Read the cached model list for one agent, falling back to the
   * adapter's hardcoded defaults when no cache is present.
   *
   * This is the read path the `models.list` / `models.listAll` routers
   * hit, so it must NOT spawn a real metadata agent or touch the SDK —
   * the fallback path uses a fresh adapter only to extract the static
   * default list, which every adapter implements synchronously.
   */
  async getCachedOrDefaults(agentId: string): Promise<CachedAgentModel[]> {
    const settings = this.queries.load();
    return this.getCachedOrDefaultsFromSnapshot(settings, agentId);
  }

  /**
   * Compose the full payload the `models.list` tRPC procedure returns
   * for one agent: `{ models, defaultModel, updatedAt }`. Keeps the
   * shape assembly (settings load + agent resolution + cache lookup)
   * in the service tier so the router stays a single delegating call
   * and the same composition is reachable from other callers without
   * duplicating the field-by-field assembly logic.
   */
  async listForAgent(
    agentId: string | undefined,
    snapshot?: Settings,
  ): Promise<{
    models: CachedAgentModel[];
    defaultModel?: string;
    updatedAt?: number;
  }> {
    const settings = snapshot ?? this.queries.load();
    const def = SettingsService.resolveAgent(settings, agentId);
    const models = await this.getCachedOrDefaultsFromSnapshot(settings, def.id);
    return {
      models,
      defaultModel: def.model,
      updatedAt: def.cachedModelsUpdatedAt,
    };
  }

  /**
   * Snapshot-based variant of `getCachedOrDefaults` — callers (and other
   * methods on this service) that already hold a settings snapshot pass
   * it in to avoid a duplicate `readFileSync`. The cache-hit path is pure;
   * only the fallback path touches the agent pool.
   */
  async getCachedOrDefaultsFromSnapshot(
    settings: Settings,
    agentId: string,
  ): Promise<CachedAgentModel[]> {
    const def = (settings.codingAgents ?? []).find((a) => a.id === agentId);
    if (def?.cachedModels && def.cachedModels.length > 0) {
      return def.cachedModels;
    }
    // Fall back to the adapter's static default list. We instantiate a
    // throwaway metadata agent and call its sync `listModels()` — every
    // adapter implements that path without I/O so it's cheap.
    try {
      const agent = await this.pool.createMetadataAgent(agentId);
      if (!agent.listModels) return [];
      const models = await agent.listModels();
      return models.map(toCachedModel);
    } catch (err) {
      log.warn({ agentId, err }, "failed to load adapter defaults; returning empty list");
      return [];
    }
  }

  /**
   * Refresh the cached model list for one agent and persist the result
   * in `~/.band/settings.json`. On failure (no network, missing binary,
   * SDK throws), logs a warning and returns the previously cached list
   * (or the adapter's defaults) without overwriting the cache.
   *
   * If the SDK fetch succeeds but the agent isn't found in
   * `settings.codingAgents` (the boot-time race against
   * `ensureSettingsDefaults`, or a stale `agentId` arrived through the
   * router), the cache write is skipped and `error` is set so the caller
   * doesn't render a misleading "Last refreshed just now" timestamp.
   */
  async refresh(agentId: string): Promise<ModelRefreshResult> {
    const now = Date.now();
    let fresh: AgentModel[] | undefined;
    let error: string | undefined;

    try {
      const agent = await this.pool.createMetadataAgent(agentId);
      if (!agent.refreshModels) {
        // Adapter has no refresh implementation — fall back to its static
        // defaults so the cache still gets seeded with something useful.
        if (!agent.listModels) {
          throw new Error("adapter exposes neither refreshModels nor listModels");
        }
        fresh = await agent.listModels();
      } else {
        fresh = await agent.refreshModels();
      }
    } catch (err) {
      // Surface only a sanitized classification to the tRPC response —
      // raw error messages from the SDK can include filesystem paths,
      // partial commands, or other host state the client doesn't need
      // to see. The full `err` (including the stack) is still logged
      // server-side at warn level for operator debugging.
      error = classifyRefreshError(err);
      log.warn({ agentId, err }, "failed to refresh models; keeping prior cache");
    }

    // Load settings once and reuse for both the persist (when fresh) and
    // the fallback path (when refresh failed). Avoids the 2-3 redundant
    // settings.json reads the prior implementation paid.
    const settings = this.queries.load();

    if (fresh) {
      const cachedFresh = fresh.map(toCachedModel);
      const persisted = this.persistFromSnapshot(settings, agentId, cachedFresh, now);
      if (!persisted) {
        // SDK fetch worked, but the agent isn't in settings.codingAgents.
        // Don't pretend the cache was updated — fall through to the
        // failure branch with an explicit error so the UI surface and
        // boot-time logging both see the no-op.
        const priorUpdated = (settings.codingAgents ?? []).find(
          (a) => a.id === agentId,
        )?.cachedModelsUpdatedAt;
        return {
          agentId,
          models: cachedFresh,
          updatedAt: priorUpdated ?? 0,
          error: "agent not in settings.codingAgents; cache not persisted",
        };
      }
      return {
        agentId,
        models: cachedFresh,
        updatedAt: now,
      };
    }

    // Refresh failed — return the prior cache without touching the
    // on-disk settings. Read the cache DIRECTLY off the snapshot rather
    // than via `getCachedOrDefaultsFromSnapshot`: the fallback path in
    // that helper spawns a fresh metadata agent on a cache miss, and
    // since the refresh just failed (typically a missing/broken binary)
    // a second spawn would only fail again — doubling the subprocess
    // cost for nothing. An empty list on a cache miss is the correct
    // "we have nothing to show yet" signal; the `error` field tells the
    // caller why.
    const def = (settings.codingAgents ?? []).find((a) => a.id === agentId);
    return {
      agentId,
      models: def?.cachedModels ?? [],
      updatedAt: def?.cachedModelsUpdatedAt ?? 0,
      error,
    };
  }

  /**
   * Refresh the model list for every configured coding agent. Used at
   * server boot to seed the cache without blocking startup. Per-agent
   * failures are isolated — one agent's failure does not affect the
   * others — and each is logged at warn level. The orchestrator runs
   * agents sequentially to avoid racing the settings.json read/write
   * cycle (see file-level comment).
   */
  async refreshAll(): Promise<ModelRefreshResult[]> {
    const settings = this.queries.load();
    const agents = settings.codingAgents ?? [];
    const results: ModelRefreshResult[] = [];
    for (const def of agents) {
      results.push(await this.refresh(def.id));
    }
    return results;
  }

  /**
   * Read the cached model list for every configured coding agent. This is
   * what the Settings UI and the chat model picker call — a single
   * settings.json read returns the full {agentId → models} map plus the
   * `cachedModelsUpdatedAt` timestamp so the UI can render staleness.
   * When an agent has no cached entry yet, falls back to the adapter's
   * static defaults via `getCachedOrDefaultsFromSnapshot`.
   */
  async getAllCachedOrDefaults(): Promise<
    {
      agentId: string;
      agentType: string;
      agentLabel: string;
      models: CachedAgentModel[];
      updatedAt?: number;
      defaultModel?: string;
    }[]
  > {
    return this.getAllCachedOrDefaultsFromSnapshot(this.queries.load());
  }

  /**
   * Snapshot-based variant. Callers (the `models.listAll` tRPC handler)
   * that already hold a settings snapshot pass it in so this method
   * does zero file reads of its own.
   */
  async getAllCachedOrDefaultsFromSnapshot(settings: Settings): Promise<
    {
      agentId: string;
      agentType: string;
      agentLabel: string;
      models: CachedAgentModel[];
      updatedAt?: number;
      defaultModel?: string;
    }[]
  > {
    const agents = settings.codingAgents ?? [];
    const out: Awaited<ReturnType<typeof this.getAllCachedOrDefaultsFromSnapshot>> = [];
    for (const def of agents) {
      const models = await this.getCachedOrDefaultsFromSnapshot(settings, def.id);
      out.push({
        agentId: def.id,
        agentType: def.type,
        agentLabel: def.label,
        models,
        updatedAt: def.cachedModelsUpdatedAt,
        defaultModel: def.model,
      });
    }
    return out;
  }

  /**
   * Persist a refreshed model list back into `settings.codingAgents`,
   * given an already-loaded snapshot. Returns `true` when the matching
   * agent entry was found and the patch was written, `false` when the
   * agent is unknown (the caller surfaces that as an explicit error
   * rather than reporting a phantom successful refresh).
   *
   * Note: the underlying `SettingsQueries.save()` itself re-reads the
   * file and merges, so the snapshot only guards the find-and-mutate
   * step in this method — concurrent writers are still serialised at
   * the file-level by `save()`'s rename-over-tmp pattern.
   */
  private persistFromSnapshot(
    settings: Settings,
    agentId: string,
    models: CachedAgentModel[],
    updatedAt: number,
  ): boolean {
    const agents = settings.codingAgents ?? [];
    const idx = agents.findIndex((a) => a.id === agentId);
    if (idx === -1) {
      log.warn({ agentId }, "refresh result for unknown agent; not persisting");
      return false;
    }
    const next: CodingAgentDefinition[] = agents.map((a, i) =>
      i === idx ? { ...a, cachedModels: models, cachedModelsUpdatedAt: updatedAt } : a,
    );
    const patch: Partial<Settings> = { codingAgents: next };
    this.queries.save(patch);
    return true;
  }
}

function toCachedModel(m: AgentModel): CachedAgentModel {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    contextWindow: m.contextWindow,
  };
}

/**
 * Classify a refresh failure into a short, host-state-free string the
 * tRPC response can carry safely. The full `err` stays in the
 * server-side log line; this is what the UI renders next to the
 * "Refresh failed" banner.
 */
function classifyRefreshError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found|spawn .* ENOENT/i.test(raw)) return "agent binary not found";
  if (/ETIMEDOUT|timed out|timeout/i.test(raw)) return "agent did not respond in time";
  if (/ECONNREFUSED|ECONNRESET|ENETUNREACH|EAI_AGAIN/i.test(raw)) return "network error";
  if (/SyntaxError|Unexpected token|JSON/i.test(raw)) return "could not parse model catalog";
  if (/permission denied|EACCES|EPERM/i.test(raw)) return "permission denied";
  return "refresh failed";
}

/**
 * Shared singleton consumed by the `models.refresh` router and by
 * `runFirstTimeSetup` for the boot-time background refresh.
 */
export const modelRefreshService = new ModelRefreshService();
