import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
   */
  load(): Settings {
    try {
      const data = readFileSync(settingsFile(), "utf-8");
      return JSON.parse(data) as Settings;
    } catch {
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
  }
}
