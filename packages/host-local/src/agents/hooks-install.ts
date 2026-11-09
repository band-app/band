import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HooksStatus } from "@band-app/host-api";
import { whichBinary } from "../process/path";

/**
 * The Claude Code events Band listens to. `SessionEnd` drops the session's
 * status source when Claude Code exits.
 */
const HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PostCompact",
  "SessionEnd",
];

/** Raised when the event list or the command shape changes; the banner shows again once. */
export const HOOKS_VERSION = 2;

/** Seconds Claude Code waits for a hook. A hook that hangs must not hold the agent. */
export const HOOK_TIMEOUT_SECONDS = 5;

export type HookCommand = { type?: string; command?: string; [key: string]: unknown };
export type HookEntry = { hooks?: HookCommand[]; [key: string]: unknown };

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** The parsed settings file and how it was written, so a rewrite keeps its layout. */
export interface LoadedSettings {
  settings: Record<string, unknown>;
  indent: string | number;
  trailingNewline: boolean;
}

/**
 * Reads `~/.claude/settings.json`. A missing file is empty settings. A file
 * that exists but is not a JSON object throws, so a write never replaces
 * settings Band could not read.
 */
export function loadClaudeSettings(path: string = claudeSettingsPath()): LoadedSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: {}, indent: 2, trailingNewline: false };
    }
    throw err;
  }
  if (text.trim() === "") return { settings: {}, indent: 2, trailingNewline: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; fix it before installing hooks.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object; fix it before installing hooks.`);
  }
  const indentMatch = /^([ \t]+)\S/m.exec(text);
  return {
    settings: parsed as Record<string, unknown>,
    indent: indentMatch ? indentMatch[1] : 2,
    trailingNewline: text.endsWith("\n"),
  };
}

/**
 * Writes the settings through a temporary file beside the real file, then
 * renames it over the original. A symlinked settings file is written through
 * (the link stays), and the original's permissions carry over.
 */
export function saveClaudeSettings(
  { settings, indent, trailingNewline }: LoadedSettings,
  settingsPath: string = claudeSettingsPath(),
): void {
  writeTextAtomic(
    settingsPath,
    JSON.stringify(settings, null, indent) + (trailingNewline ? "\n" : ""),
  );
}

/**
 * Writes `text` through a temporary file beside the real file, then renames
 * it over the original. A symlinked file is written through (the link
 * stays), and the original's permissions carry over.
 */
export function writeTextAtomic(filePath: string, text: string): void {
  let path = filePath;
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    path = realpathSync(path);
    mode = statSync(path).mode & 0o777;
  } catch {
    // No file yet: a new one is private to the user.
  }
  const temp = `${path}.band-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf-8", mode, flag: "wx" });
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file was never created or is already gone.
    }
    throw err;
  }
}

/** `band notify` as a command line: the older `/usr/local/bin/band notify` and today's wrapped form. */
const BAND_NOTIFY = /(^|[\s"'/\\])band(\.exe|\.cmd)?["']?\s+notify(\s|$)/;

export function isBandHook(command: string): boolean {
  return BAND_NOTIFY.test(command);
}

export function isBandEntry(entry: unknown): boolean {
  const hooks = (entry as HookEntry | null)?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (h) => h?.type === "command" && typeof h.command === "string" && isBandHook(h.command),
    )
  );
}

/**
 * Whether a hook command is the current one: it names an agent, and the
 * shell discards its output and its exit code, so a missing `band` binary
 * or a failing hub never reaches Claude Code.
 */
export function isCurrentCommand(
  hook: HookCommand,
  agent: string = "claude-code",
  needsAsync: boolean = true,
): boolean {
  const command = hook.command ?? "";
  return (
    command.includes(`--agent ${agent} `) &&
    command.includes(">/dev/null 2>&1") &&
    command.trimEnd().endsWith("|| true") &&
    (!needsAsync || hook.async === true)
  );
}

export function hooksOf(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks;
  return hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : {};
}

export async function checkHooks(): Promise<HooksStatus> {
  let settings: Record<string, unknown>;
  try {
    settings = loadClaudeSettings().settings;
  } catch {
    // Unreadable settings: nothing of Band's is known to be there.
    return statusOf(0, 0, false);
  }
  const hooks = hooksOf(settings);

  let current = 0;
  let bandEvents = 0;
  let otherHookCount = 0;
  for (const [event, eventHooks] of Object.entries(hooks)) {
    if (!Array.isArray(eventHooks)) continue;
    let eventHasBand = false;
    let eventIsCurrent = false;
    for (const entry of eventHooks) {
      const inner = (entry as HookEntry | null)?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (h?.type !== "command" || typeof h.command !== "string") continue;
        if (isBandHook(h.command)) {
          eventHasBand = true;
          if (HOOK_EVENTS.includes(event) && isCurrentCommand(h)) eventIsCurrent = true;
        } else {
          otherHookCount++;
        }
      }
    }
    if (eventHasBand) bandEvents++;
    if (eventIsCurrent) current++;
  }
  return statusOf(bandEvents, current, otherHookCount > 0);
}

export function statusOf(
  bandEvents: number,
  currentEvents: number,
  otherHooksExist: boolean,
  totalEvents: number = HOOK_EVENTS.length,
  version: number = HOOKS_VERSION,
): HooksStatus {
  const installed = currentEvents >= totalEvents && bandEvents === currentEvents;
  return {
    installed,
    outdated: !installed && bandEvents > 0,
    other_hooks_exist: otherHooksExist,
    version,
  };
}

/**
 * The hook command for `bandPath`. The shell discards the output and the
 * exit code, so a missing binary ("command not found") or a failing hub is
 * invisible to Claude Code. Claude Code runs hooks through Git Bash on
 * Windows, so the same form serves there.
 */
export function hookCommand(bandPath: string, agent: string = "claude-code"): string {
  return `"${bandPath}" notify --agent ${agent} >/dev/null 2>&1 || true`;
}

export async function findBand(): Promise<string> {
  // The `/usr/local/bin/band` symlink is POSIX-only; on Windows resolve it
  // off PATH (`where band`) instead.
  if (process.platform !== "win32") {
    try {
      await import("node:fs/promises").then((m) => m.stat("/usr/local/bin/band"));
      return "/usr/local/bin/band";
    } catch {
      // Try which
    }
  }
  const found = await whichBinary("band");
  if (!found) throw new Error("Could not find band CLI binary. Please install it first.");
  return found;
}

/** `hooks` without Band's entries; events left empty are dropped. */
export function withoutBandEntries(hooks: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [event, eventHooks] of Object.entries(hooks)) {
    if (!Array.isArray(eventHooks)) {
      result[event] = eventHooks;
      continue;
    }
    // An entry with Band's command next to others keeps the others.
    const kept: unknown[] = [];
    for (const entry of eventHooks) {
      if (!isBandEntry(entry)) {
        kept.push(entry);
        continue;
      }
      const e = entry as HookEntry;
      const rest = (e.hooks ?? []).filter(
        (h) => !(h?.type === "command" && typeof h.command === "string" && isBandHook(h.command)),
      );
      if (rest.length > 0) kept.push({ ...e, hooks: rest });
    }
    // Drop an event only when Band's entries were all it held.
    if (kept.length > 0 || eventHooks.length === 0) result[event] = kept;
  }
  return result;
}

/** Installs (or replaces) Band's hooks and leaves every other setting as it was. */
export async function installHooks(): Promise<void> {
  const bandPath = await findBand();
  const loaded = loadClaudeSettings();
  const hooks = withoutBandEntries(hooksOf(loaded.settings));
  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [
      ...existing,
      {
        hooks: [
          {
            type: "command",
            command: hookCommand(bandPath),
            async: true,
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ];
  }
  loaded.settings.hooks = hooks;
  saveClaudeSettings(loaded);
}

/** Removes Band's hooks only. A settings file that does not exist is left alone. */
export async function removeHooks(): Promise<void> {
  const loaded = loadClaudeSettings();
  if (!("hooks" in loaded.settings)) return;
  const before = hooksOf(loaded.settings);
  const after = withoutBandEntries(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  if (Object.keys(after).length > 0) loaded.settings.hooks = after;
  else delete loaded.settings.hooks;
  saveClaudeSettings(loaded);
}
