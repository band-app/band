/**
 * Reads `~/.band/settings.json`. Equivalent to
 * `apps/dashboard/src-tauri/src/state.rs`. We only ever read here — the web
 * server is the writer for `tokenSecret` and any user-facing settings.
 *
 * Field names use the snake-case JSON shape the web server emits, but we
 * keep TypeScript camelCase for our internal getters.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bandHome } from "./log.js";

const DEFAULT_WEB_SERVER_PORT = 3456;

interface RawSettings {
  webServerPort?: number;
  tokenSecret?: string;
  // Other fields exist in settings.json (worktreesDir, defaults, codingAgent,
  // notifications, labels, autoStartTunnel, …) but the desktop shell only
  // needs port and token.
  [key: string]: unknown;
}

function settingsFile(): string {
  return join(bandHome(), "settings.json");
}

export function loadSettings(): RawSettings {
  try {
    const raw = readFileSync(settingsFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as RawSettings;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export function getConfiguredPort(): number {
  try {
    const settings = loadSettings();
    if (typeof settings.webServerPort === "number") {
      return settings.webServerPort;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_WEB_SERVER_PORT;
}

/**
 * Token written by the web server on startup. The desktop shell embeds this
 * into the loaded URL (`?token=<secret>`) so the renderer can authenticate
 * against the local API.
 */
export function tryGetToken(): string | null {
  try {
    const settings = loadSettings();
    if (typeof settings.tokenSecret === "string" && settings.tokenSecret.length > 0) {
      return settings.tokenSecret;
    }
  } catch {
    // ignore — caller will retry
  }
  return null;
}
