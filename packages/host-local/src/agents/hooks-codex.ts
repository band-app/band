import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HooksStatus } from "@band-app/host-api";
import { parse as parseToml } from "smol-toml";
import { HOOK_TIMEOUT_SECONDS, hookCommand, statusOf, writeTextAtomic } from "./hooks-install";
import {
  checkJsonHooks,
  inspectJsonHooks,
  installJsonHooks,
  type JsonHooksSpec,
  readJsonHooks,
  removeJsonHooks,
} from "./hooks-json-agent";

/**
 * Codex events Band listens to (payloads recorded against codex-cli 0.153.4).
 * Codex has no `StopFailure`; an interrupted turn fires `Interrupt`.
 */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "Interrupt",
] as const;

/** Raised when the event list or the command shape changes; the banner shows again once. */
export const CODEX_HOOKS_VERSION = 4;

/** The label Codex keys a hook's trust by (`hooks.state."<file>:<label>:<group>:<handler>"`). */
const EVENT_LABEL: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  Stop: "stop",
  Interrupt: "interrupt",
};

/** Codex clamps an `Interrupt` hook to 3 seconds and hashes the clamped value. */
function timeoutFor(event: string): number {
  return event === "Interrupt" ? Math.min(3, HOOK_TIMEOUT_SECONDS) : HOOK_TIMEOUT_SECONDS;
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function codexHooksPath(): string {
  return join(codexHome(), "hooks.json");
}

function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

export const codexSpec: JsonHooksSpec = {
  agent: "codex",
  path: codexHooksPath,
  events: CODEX_HOOK_EVENTS,
  version: CODEX_HOOKS_VERSION,
  needsAsync: false,
  hook: (bandPath, event) => ({
    type: "command",
    command: hookCommand(bandPath, "codex"),
    timeout: timeoutFor(event),
  }),
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The hash Codex stores in `trusted_hash` for a hook without a matcher or status message. */
export function codexTrustedHash(label: string, command: string, timeout: number): string {
  const identity = {
    event_name: label,
    hooks: [{ type: "command", command, timeout, async: false }],
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(identity)))
    .digest("hex")}`;
}

/** The path Codex uses in a trust key: the file with symlinks resolved. */
function trustSourcePath(): string {
  try {
    return realpathSync(codexHooksPath());
  } catch {
    return codexHooksPath();
  }
}

function trustKey(label: string, groupIndex: number): string {
  return `${trustSourcePath()}:${label}:${groupIndex}:0`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function readConfig(): string {
  try {
    return readFileSync(codexConfigPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Throws when `config.toml` exists and does not parse, so no write replaces it. */
function readValidConfig(): string {
  const text = readConfig();
  try {
    parseToml(text);
  } catch {
    throw new Error(`${codexConfigPath()} is not valid TOML; fix it before installing hooks.`);
  }
  return text;
}

/** Writes `text` to config.toml only if it still parses, so an edit never leaves Codex a file it cannot load. */
function writeValidConfig(text: string): void {
  try {
    parseToml(text);
  } catch {
    throw new Error(
      `${codexConfigPath()} would not be valid TOML after the edit; it was left unchanged.`,
    );
  }
  writeTextAtomic(codexConfigPath(), text);
}

const HEADER = /^\s*\[/;

/** `text` without the `[hooks.state."<key>"]` tables of `keys`. */
function withoutTrustTables(text: string, keys: ReadonlySet<string>): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (HEADER.test(line)) {
      const m = /^\s*\[hooks\.state\."((?:[^"\\]|\\.)*)"\]\s*(#.*)?$/.exec(line);
      skipping = m !== null && keys.has(m[1].replace(/\\(.)/g, "$1"));
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function withTrustTables(text: string, entries: { key: string; hash: string }[]): string {
  let out = text;
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  for (const { key, hash } of entries) {
    out += `\n[hooks.state.${tomlString(key)}]\nenabled = true\ntrusted_hash = ${tomlString(hash)}\n`;
  }
  return out;
}

/** The trust keys of the Band hooks now in `hooks.json`. */
function bandTrustKeys(settings: Record<string, unknown>): Map<string, string> {
  const keys = new Map<string, string>();
  const { found } = inspectJsonHooks(codexSpec, settings);
  for (const [event, f] of found) {
    const label = EVENT_LABEL[event as keyof typeof EVENT_LABEL];
    if (!label) continue;
    keys.set(
      trustKey(label, f.groupIndex),
      codexTrustedHash(label, f.hook.command ?? "", timeoutFor(event)),
    );
  }
  return keys;
}

export async function checkCodexHooks(): Promise<HooksStatus> {
  const status = await checkJsonHooks(codexSpec);
  if (!status.installed) return status;
  // Codex skips a hook whose hash is not in config.toml, so untrusted counts as outdated.
  const loaded = readJsonHooks(codexSpec);
  let trusted: Record<string, { trusted_hash?: unknown }> = {};
  try {
    const parsed = parseToml(readConfig()) as { hooks?: { state?: typeof trusted } };
    trusted = parsed.hooks?.state ?? {};
  } catch {
    return statusOf(
      codexSpec.events.length,
      0,
      status.other_hooks_exist,
      codexSpec.events.length,
      CODEX_HOOKS_VERSION,
    );
  }
  const wanted = bandTrustKeys(loaded?.settings ?? {});
  const allTrusted = [...wanted].every(([key, hash]) => trusted[key]?.trusted_hash === hash);
  return allTrusted ? status : { ...status, installed: false, outdated: true };
}

/**
 * Installs Band's hooks into `hooks.json` and writes the `trusted_hash` table
 * Codex needs before it runs a hook. Both files must parse first; neither is
 * written otherwise.
 */
export async function installCodexHooks(): Promise<void> {
  const configBefore = readValidConfig();
  const oldLoaded = readJsonHooks(codexSpec);
  const oldKeys = new Set(oldLoaded ? bandTrustKeys(oldLoaded.settings).keys() : []);
  await installJsonHooks(codexSpec, (settings) => {
    const fresh = bandTrustKeys(settings);
    const stripped = withoutTrustTables(configBefore, new Set([...oldKeys, ...fresh.keys()]));
    writeValidConfig(
      withTrustTables(
        stripped,
        [...fresh].map(([key, hash]) => ({ key, hash })),
      ),
    );
  });
}

export async function removeCodexHooks(): Promise<void> {
  const configBefore = readValidConfig();
  const loaded = readJsonHooks(codexSpec);
  const keys = new Set(loaded ? bandTrustKeys(loaded.settings).keys() : []);
  await removeJsonHooks(codexSpec, () => {
    if (keys.size === 0) return;
    writeValidConfig(withoutTrustTables(configBefore, keys));
  });
}
