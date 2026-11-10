import type { HooksStatus } from "@band-app/host-api";
import {
  findBand,
  type HookCommand,
  type HookEntry,
  hooksOf,
  isBandHook,
  isCurrentCommand,
  type LoadedSettings,
  loadClaudeSettings,
  saveClaudeSettings,
  statusOf,
  withoutBandEntries,
} from "./hooks-install";

/**
 * Agents that keep their hooks in a JSON file shaped like Claude Code's
 * (`hooks.<Event>[].hooks[]`): Gemini CLI's `settings.json` and Codex's
 * `hooks.json`. Each agent supplies its events, its file and the hook entry;
 * the read, merge and write rules are shared with the Claude Code installer.
 */
export interface JsonHooksSpec {
  /** The `--agent` name in the hook command. */
  agent: string;
  path: () => string;
  events: readonly string[];
  /** The version of this agent's hook set. */
  version: number;
  /** Whether the agent runs the hook off its own thread, so a current hook must say `async`. */
  needsAsync: boolean;
  hook: (bandPath: string, event: string) => HookCommand;
}

/** Band's hook of one event as it sits in the file. */
export interface FoundHook {
  groupIndex: number;
  hook: HookCommand;
  current: boolean;
}

export interface Inspection {
  found: Map<string, FoundHook>;
  /** Events that hold any Band hook, current or not. */
  bandEvents: number;
  otherHooksExist: boolean;
}

export function inspectJsonHooks(
  spec: JsonHooksSpec,
  settings: Record<string, unknown>,
): Inspection {
  const found = new Map<string, FoundHook>();
  let bandEvents = 0;
  let others = 0;
  for (const [event, eventHooks] of Object.entries(hooksOf(settings))) {
    if (!Array.isArray(eventHooks)) continue;
    let eventHasBand = false;
    eventHooks.forEach((entry, groupIndex) => {
      const inner = (entry as HookEntry | null)?.hooks;
      if (!Array.isArray(inner)) return;
      for (const h of inner) {
        if (h?.type !== "command" || typeof h.command !== "string") continue;
        if (!isBandHook(h.command)) {
          others++;
          continue;
        }
        eventHasBand = true;
        const current =
          spec.events.includes(event) && isCurrentCommand(h, spec.agent, spec.needsAsync);
        const before = found.get(event);
        if (!before || (current && !before.current))
          found.set(event, { groupIndex, hook: h, current });
      }
    });
    if (eventHasBand) bandEvents++;
  }
  return { found, bandEvents, otherHooksExist: others > 0 };
}

export function statusFromInspection(spec: JsonHooksSpec, inspection: Inspection): HooksStatus {
  const current = [...inspection.found.entries()].filter(
    ([event, f]) => f.current && spec.events.includes(event),
  ).length;
  return statusOf(
    inspection.bandEvents,
    current,
    inspection.otherHooksExist,
    spec.events.length,
    spec.version,
  );
}

/** Unreadable settings count as nothing installed, as for Claude Code. */
export function readJsonHooks(spec: JsonHooksSpec): LoadedSettings | null {
  try {
    return loadClaudeSettings(spec.path());
  } catch {
    return null;
  }
}

export async function checkJsonHooks(spec: JsonHooksSpec): Promise<HooksStatus> {
  const loaded = readJsonHooks(spec);
  if (!loaded) return statusOf(0, 0, false, spec.events.length, spec.version);
  return statusFromInspection(spec, inspectJsonHooks(spec, loaded.settings));
}

/**
 * Installs (or replaces) Band's hooks in the agent's file and leaves every
 * other entry as it was. A file that does not parse throws and stays as it
 * is. `afterSave` runs once the file is written (Codex trusts it there).
 */
export async function installJsonHooks(
  spec: JsonHooksSpec,
  afterSave?: (settings: Record<string, unknown>) => void,
): Promise<void> {
  const bandPath = await findBand();
  const loaded = loadClaudeSettings(spec.path());
  const hooks = withoutBandEntries(hooksOf(loaded.settings));
  for (const event of spec.events) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, { hooks: [spec.hook(bandPath, event)] }];
  }
  loaded.settings.hooks = hooks;
  saveClaudeSettings(loaded, spec.path());
  afterSave?.(loaded.settings);
}

/** Removes Band's hooks only. A file that does not exist is left alone. */
export async function removeJsonHooks(
  spec: JsonHooksSpec,
  afterSave?: (settings: Record<string, unknown>) => void,
): Promise<void> {
  const loaded = loadClaudeSettings(spec.path());
  if (!("hooks" in loaded.settings)) return;
  const before = hooksOf(loaded.settings);
  const after = withoutBandEntries(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  if (Object.keys(after).length > 0) loaded.settings.hooks = after;
  else delete loaded.settings.hooks;
  saveClaudeSettings(loaded, spec.path());
  afterSave?.(loaded.settings);
}
