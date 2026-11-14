/**
 * One-time conversion of the settings that named the removed credential mechanisms.
 *
 * It runs before the database migration that drops `agent_logins` and turns `git` vault items into
 * plain ones, because it reads both. It changes `settings.json` only:
 *
 * - a worker profile's `credentials.gh` becomes the secret mapping `GH_TOKEN`;
 * - each of its `credentials.agentLogins` becomes the variable that login's kind used
 *   (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, ...), mapped to the login's vault item;
 * - `credentials.git` is dropped, with a log line;
 * - `hubGithubToken` names the broadest github.com `git` item, the one the hub used before.
 *
 * It does nothing once the tables and `git` items are gone, so a restart repeats nothing.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createLogger } from "@band-app/logger";
import { bandHome } from "./queries/settings";

const log = createLogger("legacy-credentials");

/** The variable that carried the secret of an agent login of this agent type and kind. */
const LOGIN_SECRET_VAR: Record<string, Record<string, string>> = {
  "claude-code": { "setup-token": "CLAUDE_CODE_OAUTH_TOKEN", "api-key": "ANTHROPIC_API_KEY" },
  codex: { "api-key": "OPENAI_API_KEY" },
  opencode: {
    "anthropic-api-key": "ANTHROPIC_API_KEY",
    "openai-api-key": "OPENAI_API_KEY",
    "openrouter-api-key": "OPENROUTER_API_KEY",
    "gemini-api-key": "GEMINI_API_KEY",
  },
  "gemini-cli": { "api-key": "GEMINI_API_KEY" },
  "cursor-cli": { "api-key": "CURSOR_API_KEY" },
  amp: { "api-key": "AMP_API_KEY" },
  copilot: { token: "COPILOT_GITHUB_TOKEN" },
};

interface LoginRow {
  id: string;
  label: string;
  agentType: string;
  kind: string;
  itemName: string | null;
}

interface Profile {
  name?: unknown;
  credentials?: { git?: unknown; gh?: unknown; agentLogins?: unknown };
  secrets?: { item: string; env: string }[];
  [key: string]: unknown;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

export function convertLegacyCredentialSettings(db: DatabaseSync): void {
  const file = join(bandHome(), "settings.json");
  const hasLogins = tableExists(db, "agent_logins");
  const gitItems = tableExists(db, "vault_items")
    ? (db.prepare("SELECT name, scope, metadata FROM vault_items WHERE kind = 'git'").all() as {
        name: string;
        scope: string;
        metadata: string;
      }[])
    : [];
  if (!hasLogins && gitItems.length === 0) return;
  if (!existsSync(file)) return;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    log.warn("settings.json could not be read, so old profile credentials were not converted");
    return;
  }

  let changed = false;
  const logins: LoginRow[] = hasLogins
    ? (db
        .prepare(
          `SELECT l.id AS id, l.label AS label, l.agent_type AS agentType, l.kind AS kind, v.name AS itemName
           FROM agent_logins l LEFT JOIN vault_items v ON v.id = l.vault_item_id`,
        )
        .all() as unknown as LoginRow[])
    : [];

  if (Array.isArray(settings.workerProfiles)) {
    for (const entry of settings.workerProfiles as Profile[]) {
      const credentials = entry?.credentials;
      if (!credentials || typeof credentials !== "object") continue;
      const secrets = [...(entry.secrets ?? [])];
      const taken = new Set(secrets.map((s) => s.env));
      const add = (item: string, env: string, why: string) => {
        if (taken.has(env)) {
          log.warn(`profile ${String(entry.name)}: ${env} is already mapped, ${why} dropped`);
          return;
        }
        taken.add(env);
        secrets.push({ item, env });
      };
      if (typeof credentials.gh === "string") add(credentials.gh, "GH_TOKEN", "gh token");
      if (Array.isArray(credentials.agentLogins)) {
        for (const ref of credentials.agentLogins as unknown[]) {
          const login = logins.find((l) => l.id === ref || l.label === ref);
          const env = login ? LOGIN_SECRET_VAR[login.agentType]?.[login.kind] : undefined;
          if (!login?.itemName || !env) {
            log.warn(
              `profile ${String(entry.name)}: agent login ${String(ref)} cannot be converted`,
            );
            continue;
          }
          add(login.itemName, env, `login ${login.label}`);
        }
      }
      if (Array.isArray(credentials.git) && credentials.git.length > 0) {
        log.warn(
          `profile ${String(entry.name)}: git credential items are no longer mapped; dropped ${credentials.git.length}`,
        );
      }
      delete entry.credentials;
      if (secrets.length > 0) entry.secrets = secrets;
      changed = true;
    }
  }

  if (settings.hubGithubToken === undefined) {
    // The hub's `gh` used the broadest global github.com item: the shortest literal path pattern.
    const literal = (metadata: string) => {
      try {
        const m = JSON.parse(metadata) as { host?: unknown; pathPattern?: unknown };
        return m.host === "github.com"
          ? String(m.pathPattern ?? "").replace(/\*/g, "").length
          : null;
      } catch {
        return null;
      }
    };
    const best = gitItems
      .filter((i) => i.scope === "global")
      .map((i) => ({ name: i.name, len: literal(i.metadata) }))
      .filter((i): i is { name: string; len: number } => i.len !== null)
      .sort((a, b) => a.len - b.len)[0];
    if (best) {
      settings.hubGithubToken = best.name;
      changed = true;
      log.info(`Hub GitHub token is now the vault item "${best.name}"`);
    }
  }

  if (!changed) return;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
