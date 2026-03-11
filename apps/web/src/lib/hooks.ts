import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { whichBinary } from "./process-utils";

const HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"];

function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function loadClaudeSettings(): Record<string, unknown> {
  try {
    const data = readFileSync(claudeSettingsPath(), "utf-8");
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isBandHook(command: string): boolean {
  return command.includes("band") && command.includes("notify");
}

export async function checkHooks(): Promise<{
  installed: boolean;
  other_hooks_exist: boolean;
}> {
  const settings = loadClaudeSettings();
  const hooks = settings.hooks as Record<string, unknown[] | undefined> | undefined;

  if (!hooks) {
    return { installed: false, other_hooks_exist: false };
  }

  let bandHookCount = 0;
  let otherHookCount = 0;

  for (const [, eventHooks] of Object.entries(hooks)) {
    if (!Array.isArray(eventHooks)) continue;
    for (const hook of eventHooks) {
      const h = hook as { hooks?: Array<{ type?: string; command?: string }> };
      if (!h.hooks || !Array.isArray(h.hooks)) continue;
      for (const inner of h.hooks) {
        if (inner.type === "command" && inner.command) {
          if (isBandHook(inner.command)) {
            bandHookCount++;
          } else {
            otherHookCount++;
          }
        }
      }
    }
  }

  return {
    installed: bandHookCount >= HOOK_EVENTS.length,
    other_hooks_exist: otherHookCount > 0,
  };
}

export async function installHooks(): Promise<void> {
  // Find band binary
  let bandPath: string | null = null;
  try {
    const stat = await import("node:fs/promises").then((m) => m.stat("/usr/local/bin/band"));
    if (stat) bandPath = "/usr/local/bin/band";
  } catch {
    // Try which
  }
  if (!bandPath) {
    bandPath = await whichBinary("band");
  }
  if (!bandPath) {
    throw new Error("Could not find band CLI binary. Please install it first.");
  }

  const settingsPath = claudeSettingsPath();
  mkdirSync(dirname(settingsPath), { recursive: true });

  const settings = loadClaudeSettings();
  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;

  // Remove band hooks from any events not in HOOK_EVENTS
  for (const [event, eventHooks] of Object.entries(hooks)) {
    if (HOOK_EVENTS.includes(event)) continue;
    if (!Array.isArray(eventHooks)) continue;
    const filtered = eventHooks.filter((entry) => {
      const e = entry as { hooks?: Array<{ type?: string; command?: string }> };
      if (!e.hooks || !Array.isArray(e.hooks)) return true;
      return !e.hooks.some((h) => h.type === "command" && h.command && isBandHook(h.command));
    });
    if (filtered.length > 0) {
      hooks[event] = filtered;
    } else {
      delete hooks[event];
    }
  }

  for (const event of HOOK_EVENTS) {
    const existing = hooks[event] || [];
    // Remove existing band hooks
    const filtered = existing.filter((entry) => {
      const e = entry as { hooks?: Array<{ type?: string; command?: string }> };
      if (!e.hooks || !Array.isArray(e.hooks)) return true;
      return !e.hooks.some((h) => h.type === "command" && h.command && isBandHook(h.command));
    });

    // Add fresh band hook
    filtered.push({
      hooks: [{ type: "command", command: `${bandPath} notify` }],
    });

    hooks[event] = filtered;
  }

  settings.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}
