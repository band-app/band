import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  bandHome,
  type CodingAgentDefinition,
  type Settings,
  SettingsQueries,
} from "../infra/db/queries/settings";

/**
 * Business logic for reading and updating Band settings.
 *
 * Services tier — depends on Infra (`SettingsQueries`) but knows nothing
 * about tRPC or the API surface. All callers (routers, lib helpers, the
 * desktop bridge) should funnel through this class so we have a single
 * source of truth for derived helpers like default-agent resolution,
 * worktrees-directory resolution, and the auth-token bootstrap.
 *
 * Stateless by design: every method re-reads the file so concurrent writes
 * from the desktop shell or another web-server tab are picked up without
 * needing a cache invalidation step.
 */
export class SettingsService {
  constructor(private readonly queries: SettingsQueries = new SettingsQueries()) {}

  /**
   * Return the on-disk settings document (or `{}` if absent).
   */
  get(): Settings {
    return this.queries.load();
  }

  /**
   * Merge `patch` into the on-disk settings document and persist.
   *
   * The Infra layer handles the actual merge + atomic write; this method
   * is a thin pass-through that lets callers (and tests) target the
   * service rather than the underlying file I/O.
   */
  update(patch: Partial<Settings>): void {
    this.queries.save(patch);
  }

  /**
   * Resolve a coding-agent definition by id, given a settings snapshot.
   *
   * Static so the back-compat shim in `lib/state.ts` (which already holds
   * a `Settings` snapshot it wants to reuse without a second file read)
   * can delegate without instantiating the service. Instance callers go
   * through `getAgentDefinition` below, which loads + delegates.
   *
   * Falls back through three layers when the requested id is missing:
   *   1. The user's configured default agent (`settings.defaultCodingAgent`).
   *   2. The first agent in `settings.codingAgents`.
   *   3. A built-in `claude-code` definition so a freshly installed Band
   *      with an empty settings file can still launch.
   */
  static resolveAgent(settings: Settings, agentId?: string): CodingAgentDefinition {
    const agents = settings.codingAgents ?? [];
    if (agentId) {
      const found = agents.find((a) => a.id === agentId);
      if (found) return found;
    }
    if (settings.defaultCodingAgent) {
      const found = agents.find((a) => a.id === settings.defaultCodingAgent);
      if (found) return found;
    }
    if (agents.length > 0) return agents[0];
    return { id: "claude-code", type: "claude-code", label: "Claude Code" };
  }

  /**
   * Convenience wrapper around `SettingsService.resolveAgent` that loads
   * the current settings document itself. Use this from code paths that
   * don't already have a settings snapshot in hand.
   */
  getAgentDefinition(agentId?: string): CodingAgentDefinition {
    return SettingsService.resolveAgent(this.queries.load(), agentId);
  }

  /**
   * Where Band creates new workspace worktrees. Defaults to
   * `$BAND_HOME/worktrees` when the user hasn't overridden it.
   */
  worktreesDir(): string {
    const settings = this.queries.load();
    return settings.worktreesDir ?? join(bandHome(), "worktrees");
  }

  /**
   * Return the persisted auth token, generating + saving one on first call.
   *
   * The token gates all tRPC requests, so the first boot has to mint one
   * before the server can accept traffic. The `load()` here is the one
   * whose snapshot we mutate + persist, so concurrent writes by the
   * desktop shell (or another web-server tab) made between this `load`
   * and our `save` survive — `SettingsQueries.save` merges into whatever
   * is currently on disk rather than overwriting the file with a
   * single-key document.
   *
   * TODO(tokens): there is a check-then-act TOCTOU window between the
   * `load` and `save` here — two processes booting concurrently against
   * the same `~/.band/settings.json` (e.g. dev server + desktop shell)
   * can each observe the absence of `tokenSecret`, mint a different
   * token, and race their writes. The atomic merge in `SettingsQueries.save`
   * means the last writer wins, leaving the other process running with
   * an invalidated token. The race is rare in practice (token is minted
   * once per fresh install) but worth fixing — most likely via a
   * file-level advisory lock around the load+save pair, or by hoisting
   * the bootstrap into a single coordinator (e.g. the first-time-setup
   * step in `runFirstTimeSetup`). Pattern preserved from the pre-3-tier
   * `lib/state.ts` implementation; fixing it is out of scope for the
   * settings refactor.
   */
  getOrCreateToken(): string {
    const settings = this.queries.load();
    if (settings.tokenSecret) return settings.tokenSecret;
    const token = randomBytes(32).toString("hex");
    settings.tokenSecret = token;
    this.queries.save(settings);
    return token;
  }
}

/**
 * Shared singleton consumed by both the API tier (settings router) and the
 * legacy back-compat wrappers in `lib/state.ts`. `SettingsService` is
 * stateless aside from its `queries` dependency, so one instance is safe
 * across callers — and centralising the instance here means there's only
 * one place to update when a stateful field (cache, in-memory invalidation)
 * eventually lands.
 */
export const settingsService = new SettingsService();
