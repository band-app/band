import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  bandHome,
  type CodingAgentDefinition,
  type Settings,
  SettingsQueries,
} from "../infra/db/queries/settings";

/**
 * Zod schema for an in-flight settings update.
 *
 * Lives in the service tier (not the API router) so the service and any
 * future non-tRPC entry points (CLI, scripts, the desktop bridge) share a
 * single source of truth for the accepted shape. The settings router
 * imports this schema as its `.input(...)` validator; `SettingsService.update`
 * accepts the inferred type, so adding a field to the schema (or removing
 * one) is a compile error at every call site instead of silently drifting
 * between two definitions.
 *
 * `.passthrough()` is deliberate: the on-disk settings document is a
 * forward-compat JSON file that the desktop shell and future client versions
 * may write additional keys into. Rejecting unknown keys here would corrupt
 * the file on the next `update` round-trip from an older client. The
 * known-key schema below still narrows the common write paths — every key
 * the dashboard's `SettingsPage.tsx` writes today is enumerated, so typos
 * in those keys are caught by Zod rather than slipping through to disk.
 * The `Settings` interface uses an `[key: string]: unknown` index signature
 * for the same reason.
 *
 * NOTE: `.passthrough()` only relaxes validation for *unknown* top-level
 * keys. Known keys with hard enums (`theme`) still 400 the entire update
 * if a future client sends a value outside the closed set. That's the
 * intended trade-off for `theme` — it's a dashboard-owned closed enum, so
 * any new theme name (`"high-contrast"`, …) lands in this file alongside
 * the dashboard change that introduces it. Relax the enum to `z.string()`
 * if forward-compat for a specific known key ever outweighs the typo-catch.
 */
export const settingsUpdateInput = z
  .object({
    // `null` is allowed because the dashboard sends `worktreesDir.trim() || null`
    // when the field is cleared — the legacy behavior preserved across the
    // 3-tier migration.
    worktreesDir: z.string().nullish(),
    codingAgents: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          label: z.string(),
          command: z.string().optional(),
          model: z.string().optional(),
        }),
      )
      .optional(),
    defaultCodingAgent: z.string().optional(),
    webServerPort: z.number().optional(),
    notifications: z
      .object({
        soundOnNeedsAttention: z.boolean().optional(),
        sound: z.string().optional(),
      })
      .optional(),
    labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })).optional(),
    tokenSecret: z.string().optional(),
    autoStartTunnel: z.boolean().optional(),
    maxCachedWorkspaces: z.number().optional(),
    claudeCodePartialMessages: z.boolean().optional(),
    // Dashboard-UI-controlled boolean toggles. Enumerated so typos in keys
    // the SettingsPage actually writes are caught by Zod rather than
    // silently slipping through `.passthrough()`.
    enableLSP: z.boolean().optional(),
    enableFilePreviewTabs: z.boolean().optional(),
    useWebGLTerminalRenderer: z.boolean().optional(),
    webBrowserCdpEnabled: z.boolean().optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
  })
  .passthrough();

/**
 * Inferred update shape. Use this everywhere the schema's shape needs to
 * appear in a TypeScript signature (e.g. `SettingsService.update`, helper
 * functions that hand a patch to the service).
 */
export type SettingsUpdate = z.infer<typeof settingsUpdateInput>;

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
   * service rather than the underlying file I/O. The parameter type is
   * `SettingsUpdate` (inferred from the shared Zod schema above) so the
   * service tier and the tRPC router's `.input(...)` validator stay in
   * lock-step — adding or removing a field in the schema is a compile
   * error at every call site instead of silent drift.
   */
  update(patch: SettingsUpdate): void {
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
   *
   * Both `undefined` ("key was never written") and `null` ("user explicitly
   * cleared the field") collapse to the built-in default here — callers of
   * this method want a usable path on disk, not the raw sentinel. Callers
   * that need to distinguish "cleared" from "never set" (e.g. to render an
   * empty text box in the Settings dialog) should read `rawWorktreesDir()`
   * or `get().worktreesDir` directly instead of going through this method.
   */
  worktreesDir(): string {
    const raw = this.rawWorktreesDir();
    return raw ?? join(bandHome(), "worktrees");
  }

  /**
   * Return the raw `worktreesDir` value from settings without applying the
   * default, preserving the `null` vs `undefined` distinction documented on
   * the `Settings` interface (`null` = user explicitly cleared the field,
   * `undefined` = key was never written). Use this when the caller cares
   * about the sentinel itself (e.g. the dashboard's empty-text-box rendering
   * vs. "the user never opened Settings yet").
   */
  rawWorktreesDir(): string | null | undefined {
    return this.queries.load().worktreesDir;
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
    // Pass just the patch — `SettingsQueries.save` re-reads the file and
    // unions our patch with whatever is currently on disk, so any keys
    // written between our `load` above and this `save` survive. Passing
    // the full snapshot would happen to be correct today thanks to the
    // re-read inside `save`, but it would silently regress if `save` were
    // ever changed to trust its caller's snapshot — the `Partial<Settings>`
    // signature already advertises the right call shape.
    this.queries.save({ tokenSecret: token });
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
