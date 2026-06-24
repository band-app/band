import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Notification-channel preferences embedded in the on-disk settings document.
 */
export interface NotificationSettings {
  soundOnNeedsAttention?: boolean;
  sound?: string;
}

/**
 * One configured coding agent. The dashboard lets users register multiple
 * agent commands (claude-code, codex, gemini-cli, …) and pick a default.
 */
export interface CodingAgentDefinition {
  id: string;
  type: string;
  label: string;
  command?: string;
  model?: string;
  /**
   * Cached list of models the agent's SDK / binary reports. Refreshed by
   * `ModelRefreshService.refresh()` — explicitly from the Settings UI's
   * "Refresh models" button, and fire-and-forget at server boot.
   *
   * The picker UI (Settings + Chat) reads from this cache directly so it
   * stays populated across server restarts and across fresh chats without
   * needing a live SDK call. When the field is absent (fresh install,
   * settings.json from an older version, refresh has never succeeded),
   * callers fall back to the adapter's built-in default list — see
   * `ModelRefreshService.getCachedOrDefaults()` and the comments on
   * each adapter's `listModels()` method.
   */
  cachedModels?: CachedAgentModel[];
  /**
   * Epoch ms when `cachedModels` was last refreshed (success or attempt).
   * Surfaced in the UI so users can see staleness. Unset until the first
   * refresh completes.
   */
  cachedModelsUpdatedAt?: number;
}

/**
 * Cached model entry persisted in `~/.band/settings.json`. Mirrors
 * `AgentModel` from `@band-app/coding-agent` but kept structural here so
 * the settings shim doesn't add an inverse dependency back into the
 * coding-agent package.
 */
export interface CachedAgentModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
}

/**
 * A user-defined label for grouping/filtering projects in the dashboard.
 */
export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

/**
 * The shape of `~/.band/settings.json`.
 *
 * Settings are stored as a JSON document rather than relational rows because
 * the surface area is tiny, the structure is user-edited (with comments-by-key
 * conventions for unknown fields), and the desktop shell needs to read/write
 * it without going through the web server. The "queries" naming follows the
 * same shape as the relational query classes under `db/queries/` — the
 * Infra tier exposes a typed data-access class regardless of the backing
 * store.
 */
export interface Settings {
  /**
   * Worktrees directory. `null` is an intentional sentinel meaning "the user
   * explicitly cleared this field" (the dashboard sends `null` when the
   * input is empty); callers that resolve a usable path should fall back to
   * the default with `?? defaultDir` rather than treating `null` as "not
   * configured". `undefined` means "key was never written".
   */
  worktreesDir?: string | null;
  codingAgents?: CodingAgentDefinition[];
  defaultCodingAgent?: string;
  webServerPort?: number;
  notifications?: NotificationSettings;
  labels?: LabelDefinition[];
  tokenSecret?: string;
  autoStartTunnel?: boolean;
  /**
   * Maximum number of workspace dockview instances kept alive in memory at
   * once. Higher values speed up switching back to recent workspaces at the
   * cost of memory and background work. Defaults to 3 in the client.
   */
  maxCachedWorkspaces?: number;
  /**
   * Experimental: forward Claude Code's partial-message stream events
   * (SDK's `includePartialMessages`) so the chat bubble types in
   * token-by-token instead of in per-block bursts. Off by default.
   * See `docs/experiments/partial-messages.md`.
   */
  claudeCodePartialMessages?: boolean;
  /** Enable Language Server Protocol features (file preview hovers, etc.). */
  enableLSP?: boolean;
  /**
   * When true (default in the dashboard), single-clicking a file in the tree
   * opens it in a shared "preview" tab slot rather than pinning a new tab.
   * Mirrors `dashboard/types.ts::Settings.enableFilePreviewTabs`.
   */
  enableFilePreviewTabs?: boolean;
  /** Dashboard theme preference. */
  theme?: "system" | "light" | "dark";
  /**
   * GPU-accelerated WebGL terminal renderer. Mirrors
   * `dashboard/types.ts::Settings.useWebGLTerminalRenderer`.
   */
  useWebGLTerminalRenderer?: boolean;
  /**
   * Experimental Web Browser pane CDP screencast toggle. Mirrors
   * `dashboard/types.ts::Settings.webBrowserCdpEnabled`.
   */
  webBrowserCdpEnabled?: boolean;
  /**
   * Retention window, in days, for the Reports `usage_events` table
   * (issue #425). When unset, the prune sweep falls back to
   * `USAGE_EVENT_RETENTION_MS` (1 year). Users with extreme volumes
   * can lower this to free disk; users who want a longer history can
   * raise it (the per-hour bucketing keeps row count tiny — see the
   * JSDoc on `USAGE_EVENT_RETENTION_MS`).
   */
  usageRetentionDays?: number;
  /**
   * Whether the Reports usage scanner runs (issue #425). When `false`,
   * `UsageScannerService.tick()` is a no-op — the periodic 5-minute
   * sweep and the fire-and-forget tick triggered by opening the
   * Reports dialog are both skipped. Useful for users who don't care
   * about cost reporting and want to claw back the per-tick CPU /
   * subprocess churn (Codex/OpenCode adapters spawn helpers).
   * Defaults to `true` (treat `undefined` as enabled).
   */
  usagePollingEnabled?: boolean;
  /**
   * CLI-scoped preferences (issue #551). Today only `defaultVia` is
   * recognized — the user-level fallback for `band workspaces create
   * --prompt` dispatch when no `--via` flag, `BAND_DISPATCH` env var,
   * or repo `.band/config.json` value is set.
   */
  cli?: {
    defaultVia?: "chat" | "terminal";
    [key: string]: unknown;
  };
  /** Extra fields not explicitly modeled. Preserved across read/write. */
  [key: string]: unknown;
}

/**
 * Returns `$BAND_HOME` if set, else `~/.band`.
 *
 * Mirrors the helper that previously lived in `lib/state.ts`. Tests rely on
 * pointing `HOME` (or `BAND_HOME`) at a temp directory so the on-disk
 * settings file is isolated per run.
 */
export function bandHome(): string {
  if (process.env.BAND_HOME) return process.env.BAND_HOME;
  return join(homedir(), ".band");
}

function settingsFile(): string {
  return join(bandHome(), "settings.json");
}

/**
 * Resolve a coding agent definition by ID against a settings snapshot,
 * with the same fallback chain `SettingsService.resolveAgent` uses:
 *
 *   1. The requested agent ID, if present in `settings.codingAgents`.
 *   2. The user's configured default (`settings.defaultCodingAgent`).
 *   3. The first agent in `settings.codingAgents`.
 *   4. A built-in `claude-code` definition so a freshly installed Band
 *      with an empty settings file can still launch.
 *
 * Lives in infra so `agent-pool.ts` (also infra) can resolve definitions
 * from the same package — both sides import this function and
 * `SettingsQueries.load()` directly, with no hop through the services
 * tier. `SettingsService.resolveAgent` retains a thin static wrapper
 * around this function so legacy services-tier callers keep compiling.
 */
export function resolveAgentDefinition(
  settings: Settings,
  agentId?: string,
): CodingAgentDefinition {
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
 * Process-lifetime cache of the parsed settings document, keyed by absolute
 * file path and validated against the file's mtime.
 *
 * `settings.json` is read on hot paths — every agent hook event routes through
 * `statuses.notify` → `SettingsService.getAgentDefinition` → `load()`, and
 * `agent-pool` calls `load()` on every agent resolution — but the file changes
 * rarely (only when the user edits settings). Re-reading + re-parsing it
 * synchronously on every call needlessly parks the event loop. Caching by
 * mtime makes the steady state a single `statSync` with no `readFileSync`/
 * `JSON.parse`. A write through `save()` bumps the mtime *and* clears the entry
 * directly, so the cache is self-invalidating — there is no stale-read window.
 *
 * The cached value is treated as read-only by callers (settings are an
 * immutable on-disk snapshot; mutations go through `save()`), so returning the
 * shared reference is safe and avoids a clone.
 */
interface CachedSettings {
  mtimeMs: number;
  value: Settings;
}
const settingsCache = new Map<string, CachedSettings>();

/**
 * File-system-backed data access for `~/.band/settings.json`.
 *
 * Infra tier — knows nothing about services or routers. The class is a
 * stateless wrapper around `fs` calls; the resolved file path is computed
 * on every call so tests that mutate `HOME`/`BAND_HOME` mid-suite still see
 * the right file. Higher tiers (`SettingsService`) layer the merge semantics,
 * defaults, and token generation on top.
 *
 * NOTE on the "queries" naming: this class lives under `server/infra/db/queries/`
 * to mirror the relational query classes (`ProjectsQueries`, `WorkspacesQueries`,
 * …) even though there's no database involved — settings are persisted as a
 * single JSON document, not relational rows. "Queries" here refers to the
 * architecture pattern (typed, store-agnostic data-access) rather than SQL.
 * The on-disk format and the bypass-the-server desktop-shell write path make
 * a JSON file the right backing store; placing the class alongside the
 * relational queries keeps the Infra-tier shape uniform for callers.
 */
export class SettingsQueries {
  /**
   * Read the current settings document. Returns an empty object if the file
   * does not exist or fails to parse — callers treat an absent file as
   * "no settings yet" rather than an error.
   *
   * Backed by an mtime-keyed cache (see `settingsCache`): the steady-state
   * cost is a single `statSync`, not a `readFileSync` + `JSON.parse`.
   */
  load(): Settings {
    const filePath = settingsFile();
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      // File absent (or unstatable) — drop any stale entry and report empty.
      settingsCache.delete(filePath);
      return {};
    }
    const cached = settingsCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.value;
    }
    try {
      const value = JSON.parse(readFileSync(filePath, "utf-8")) as Settings;
      settingsCache.set(filePath, { mtimeMs, value });
      return value;
    } catch {
      settingsCache.delete(filePath);
      return {};
    }
  }

  /**
   * Persist a settings document atomically.
   *
   * Merges the patch with whatever is already on disk so unknown keys
   * written by other clients (e.g. desktop-shell extras) survive a write
   * from the web server. The write is atomic — we stage to a `.tmp.<pid>`
   * sibling and `rename` over the target — to avoid a torn file if the
   * process exits mid-write.
   *
   * `Partial<Settings>` honestly declares the merge semantics: callers may
   * pass a single key (`{ tokenSecret: "x" }`) and the load+merge step
   * preserves every other key. Typing the parameter as the full `Settings`
   * shape would mislead callers into thinking `save` is a wholesale
   * replace.
   */
  save(patch: Partial<Settings>): void {
    const filePath = settingsFile();
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      // File doesn't exist or is invalid — start fresh.
    }
    const merged = { ...existing, ...patch };
    const data = `${JSON.stringify(merged, null, 2)}\n`;
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, data, "utf-8");
    renameSync(tmpPath, filePath);
    // Drop the cache entry directly so a load() in the same coarse mtime tick
    // (some filesystems have 1s mtime resolution) can never read stale data.
    settingsCache.delete(filePath);
  }

  /**
   * Read the persisted auth token, generating + persisting one if absent.
   *
   * Lives in Infra so other infra-tier modules (e.g. the cloudflared
   * tunnel client) can read the token without crossing back up through
   * `services/`. `SettingsService.getOrCreateToken()` delegates here so
   * service-tier callers keep their existing surface unchanged.
   *
   * TODO(tokens): there is a check-then-act TOCTOU window between the
   * `load` and `save` here — two processes booting concurrently against
   * the same `~/.band/settings.json` (e.g. dev server + desktop shell)
   * can each observe the absence of `tokenSecret`, mint a different
   * token, and race their writes. The atomic merge in `save()` means the
   * last writer wins, leaving the other process running with an
   * invalidated token. The race is rare in practice (token is minted
   * once per fresh install) but worth fixing — most likely via a
   * file-level advisory lock around the load+save pair, or by hoisting
   * the bootstrap into a single coordinator (e.g. the first-time-setup
   * step in `runFirstTimeSetup`). Pattern preserved from the pre-3-tier
   * `lib/state.ts` implementation; fixing it is out of scope for the
   * settings refactor.
   */
  getOrCreateToken(): string {
    const settings = this.load();
    if (settings.tokenSecret) return settings.tokenSecret;
    const token = randomBytes(32).toString("hex");
    // Pass just the patch — `save` re-reads the file and unions our
    // patch with whatever is currently on disk, so any keys written
    // between our `load` above and this `save` survive.
    this.save({ tokenSecret: token });
    return token;
  }
}
