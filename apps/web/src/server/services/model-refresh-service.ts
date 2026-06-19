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
import { resolveAgentDefinition, SettingsQueries } from "../infra/db/queries/settings";

const log = createLogger("model-refresh");

export interface ModelRefreshResult {
  agentId: string;
  models: CachedAgentModel[];
  updatedAt: number;
  /** When refresh failed, the prior cached list (or the adapter defaults)
   *  is still returned and `error` is populated with the failure reason. */
  error?: string;
}

/** One agent's entry in the combined picker payload (`getAllCachedOrDefaults`
 *  / `listAllForPicker`). */
export interface AgentModelsEntry {
  agentId: string;
  agentType: string;
  agentLabel: string;
  models: CachedAgentModel[];
  updatedAt?: number;
  defaultModel?: string;
}

export class ModelRefreshService {
  constructor(private readonly queries: SettingsQueries = new SettingsQueries()) {}

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
    // Resolve via the infra helper directly (a service → infra
    // dependency) rather than the `SettingsService.resolveAgent` static,
    // keeping this service's dependency surface to just `SettingsQueries`
    // + the agent pool.
    const def = resolveAgentDefinition(settings, agentId);
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
    // Fall back to the adapter's static default list by instantiating a
    // throwaway metadata agent and calling its sync `listModels()`. Note
    // that `claude-code` and `codex` deliberately return `[]` from
    // `listModels()` (their canonical source is the live SDK / `codex
    // debug models`, populated via `refreshModels()`), so the fallback
    // only yields a non-empty list for adapters with static hardcoded
    // catalogues (`cursor-cli`, `gemini-cli`). For the SDK-backed
    // adapters this branch returns `[]` until the first successful
    // refresh — the correct "we have nothing to show yet" signal.
    try {
      const agent = await createMetadataAgent(agentId);
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
   * Unknown `agentId`: `createMetadataAgent` resolves through
   * `resolveAgentDefinition`, which silently falls back to the default
   * agent for an unrecognised id. We don't want a stray id to spawn the
   * default agent's subprocess, so we reject it up front with an
   * explicit error instead.
   */
  async refresh(agentId: string): Promise<ModelRefreshResult> {
    const now = Date.now();
    let fresh: AgentModel[] | undefined;
    let error: string | undefined;

    // Load settings exactly once and reuse the snapshot for the
    // existence guard, the persist step, and the failure fallback. The
    // snapshot is only used for the in-memory find-and-mutate — the
    // actual write goes through `persistFromSnapshot` → `queries.save()`,
    // which re-reads and merges against the latest on-disk document, so
    // a concurrent write isn't clobbered by this (now slightly older)
    // snapshot.
    const settings = this.queries.load();

    // Guard against the resolveAgentDefinition default-fallback: an id
    // that isn't a configured agent must not trigger a refresh of some
    // other (default) agent's subprocess.
    const known = (settings.codingAgents ?? []).some((a) => a.id === agentId);
    if (!known) {
      return { agentId, models: [], updatedAt: 0, error: "agent not found" };
    }

    try {
      const agent = await createMetadataAgent(agentId);
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

    if (fresh) {
      const cachedFresh = fresh.map(toCachedModel);
      const persisted = this.persist(agentId, cachedFresh, now);
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
   * Dispatch a refresh request: one agent when `agentId` is supplied,
   * otherwise every configured agent. Encapsulates the single-vs-all
   * branch so the `models.refresh` tRPC router stays a pure delegate
   * (validate → call service → return).
   */
  async refreshOneOrAll(agentId?: string): Promise<ModelRefreshResult[]> {
    if (agentId) {
      return [await this.refresh(agentId)];
    }
    return this.refreshAll();
  }

  /**
   * Read the cached model list for every configured coding agent. This is
   * what the Settings UI and the chat model picker call — a single
   * settings.json read returns the full {agentId → models} map plus the
   * `cachedModelsUpdatedAt` timestamp so the UI can render staleness.
   * When an agent has no cached entry yet, falls back to the adapter's
   * static defaults via `getCachedOrDefaultsFromSnapshot`.
   */
  async getAllCachedOrDefaults(): Promise<AgentModelsEntry[]> {
    return this.getAllCachedOrDefaultsFromSnapshot(this.queries.load());
  }

  /**
   * Snapshot-based variant. Callers (the `models.listAll` tRPC handler)
   * that already hold a settings snapshot pass it in so this method
   * does zero file reads of its own.
   */
  async getAllCachedOrDefaultsFromSnapshot(settings: Settings): Promise<AgentModelsEntry[]> {
    const agents = settings.codingAgents ?? [];
    const out: AgentModelsEntry[] = [];
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
   * Full payload for the chat UI's combined agent/model picker:
   * `{ agents, defaultAgentId }`. Loads settings.json once and resolves
   * the effective default-agent id (explicit `defaultCodingAgent`, else
   * the first configured agent, else "") here in the service so the
   * `models.listAll` router stays a single delegating call.
   */
  async listAllForPicker(): Promise<{
    agents: AgentModelsEntry[];
    defaultAgentId: string;
  }> {
    const settings = this.queries.load();
    const codingAgents = settings.codingAgents ?? [];
    const defaultAgentId = settings.defaultCodingAgent ?? codingAgents[0]?.id ?? "";
    const agents = await this.getAllCachedOrDefaultsFromSnapshot(settings);
    return { agents, defaultAgentId };
  }

  /**
   * Persist a refreshed model list for one agent. Returns `true` when the
   * matching agent entry was found and the patch was written, `false`
   * when the agent is no longer configured (the caller surfaces that as
   * an explicit error rather than reporting a phantom successful refresh).
   *
   * Reads the settings document FRESH here — right before the
   * find-and-mutate — rather than reusing the snapshot `refresh()` loaded
   * before its (up to 10 s) SDK call. `SettingsQueries.save()` replaces
   * the whole `codingAgents` array (shallow top-level merge), so building
   * `next` from a stale snapshot would clobber any concurrent
   * `SettingsService.update()` (e.g. a user editing a label/command/model
   * during the refresh). Re-reading shrinks that window to the
   * synchronous find→map→save critical section — the same pattern
   * `SettingsService.update()` uses for its own cache-preservation merge.
   * We only ever mutate the target agent's `cachedModels` /
   * `cachedModelsUpdatedAt`; every other field on every agent is carried
   * through from the fresh read.
   */
  private persist(agentId: string, models: CachedAgentModel[], updatedAt: number): boolean {
    const agents = this.queries.load().codingAgents ?? [];
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
