import { homedir } from "node:os";
import { join } from "node:path";
import { hookCommand } from "./hooks-install";
import type { JsonHooksSpec } from "./hooks-json-agent";

/**
 * Gemini CLI events Band listens to (recorded against Gemini CLI 0.61.0 for
 * `SessionStart` and `SessionEnd`; the rest follow the CLI's hook reference).
 * `BeforeAgent` and `AfterAgent` bracket a turn, `BeforeTool` and `AfterTool`
 * keep the turn working, `Notification` carries a tool permission prompt, and
 * `SessionEnd` drops the session's status source.
 */
export const GEMINI_HOOK_EVENTS = [
  "BeforeAgent",
  "AfterAgent",
  "BeforeTool",
  "AfterTool",
  "Notification",
  "SessionEnd",
] as const;

/** Raised when the event list or the command shape changes; the banner shows again once. */
export const GEMINI_HOOKS_VERSION = 3;

/** Gemini CLI hook timeouts are in milliseconds. */
const GEMINI_HOOK_TIMEOUT_MS = 5000;

export function geminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

/**
 * Gemini CLI waits for a hook and has no async flag, so the command is the
 * synchronous one: `band notify` answers within about a second whatever the
 * hub does, and the shell discards its output and exit code.
 */
export const geminiSpec: JsonHooksSpec = {
  agent: "gemini-cli",
  path: geminiSettingsPath,
  events: GEMINI_HOOK_EVENTS,
  version: GEMINI_HOOKS_VERSION,
  needsAsync: false,
  hook: (bandPath) => ({
    type: "command",
    command: hookCommand(bandPath, "gemini-cli"),
    timeout: GEMINI_HOOK_TIMEOUT_MS,
  }),
};
