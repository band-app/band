import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HooksStatus } from "@band-app/host-api";
import { findBand, statusOf, writeTextAtomic } from "./hooks-install";

/**
 * OpenCode has no hook configuration, only plugins: a module in
 * `<config dir>/plugins/` that OpenCode loads at start and calls with every
 * event. Band installs one file that forwards session events to
 * `band notify --agent opencode`. It owns that file name and nothing else.
 */
export const OPENCODE_HOOKS_VERSION = 3;

const PLUGIN_FILE = "band-status.js";
const MARKER = "// band-managed-hook: opencode";

function pluginsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "opencode", "plugins");
}

export function opencodePluginPath(): string {
  return join(pluginsDir(), PLUGIN_FILE);
}

/**
 * The plugin module. Each event becomes one `band notify` call with a
 * Claude-shaped payload (`hook_event_name`, `session_id`, `cwd`):
 *
 *   - `session.status` busy or retry, and a permission or question answer → `SessionBusy`
 *   - `permission.asked`, `permission.updated`, `question.asked` → `PermissionRequest`
 *   - `session.status` idle and `session.idle` → `SessionIdle`
 *   - `session.error` → `SessionError`, except an abort, which is `SessionIdle`
 *   - `session.deleted` → `SessionEnd`
 *
 * A repeat of the last event for a session is dropped. Sessions OpenCode creates with a parent (subagents) are ignored. The call
 * discards output and errors, and never waits, so it cannot hold OpenCode.
 */
export function opencodePluginSource(bandPath: string): string {
  return `${MARKER} version=${OPENCODE_HOOKS_VERSION}
import { spawn } from "node:child_process";

const BAND = ${JSON.stringify(bandPath)};
const children = new Set();
const last = new Map();

function notify(hookEventName, sessionID, cwd) {
  if (!sessionID) return;
  if (last.get(sessionID) === hookEventName) return;
  if (hookEventName === "SessionEnd") last.delete(sessionID);
  else last.set(sessionID, hookEventName);
  try {
    const child = spawn(BAND, ["notify", "--agent", "opencode"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: hookEventName, session_id: sessionID, cwd }));
    child.unref();
  } catch {}
}

export const BandStatusPlugin = async (ctx) => {
  const cwd = ctx?.directory || process.cwd();
  return {
    event: async ({ event }) => {
      try {
        const props = event?.properties || {};
        if (event?.type === "session.created") {
          if (props.info?.parentID && props.info?.id) children.add(props.info.id);
          return;
        }
        const sessionID = props.sessionID || props.info?.id;
        if (!sessionID || children.has(sessionID)) return;
        switch (event.type) {
          case "session.status": {
            const type = props.status?.type;
            if (type === "busy" || type === "retry") notify("SessionBusy", sessionID, cwd);
            else if (type === "idle") notify("SessionIdle", sessionID, cwd);
            break;
          }
          case "session.idle":
            notify("SessionIdle", sessionID, cwd);
            break;
          case "permission.asked":
          case "permission.updated":
          case "question.asked":
            notify("PermissionRequest", sessionID, cwd);
            break;
          case "permission.replied":
          case "question.replied":
          case "question.rejected":
            notify("SessionBusy", sessionID, cwd);
            break;
          case "session.error":
            notify(props.error?.name === "MessageAbortedError" ? "SessionIdle" : "SessionError", sessionID, cwd);
            break;
          case "session.deleted":
            children.delete(sessionID);
            notify("SessionEnd", sessionID, cwd);
            break;
        }
      } catch {}
    },
  };
};
`;
}

function readPlugin(): string | null {
  try {
    return readFileSync(opencodePluginPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isBandPlugin(text: string): boolean {
  return text.startsWith(MARKER);
}

function bandPathOf(text: string): string | null {
  const m = /^const BAND = (".*");$/m.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

function otherPluginsExist(): boolean {
  try {
    return readdirSync(pluginsDir()).some((f) => f !== PLUGIN_FILE && /\.(js|mjs|cjs|ts)$/.test(f));
  } catch {
    return false;
  }
}

export async function checkOpencodeHooks(): Promise<HooksStatus> {
  const others = otherPluginsExist();
  let text: string | null;
  try {
    text = readPlugin();
  } catch {
    text = null;
  }
  if (text === null || !isBandPlugin(text)) {
    return statusOf(0, 0, others, 1, OPENCODE_HOOKS_VERSION);
  }
  const path = bandPathOf(text);
  const current = path !== null && text === opencodePluginSource(path);
  return statusOf(1, current ? 1 : 0, others, 1, OPENCODE_HOOKS_VERSION);
}

/** Writes the plugin. A file of that name that is not Band's is the user's own and is refused. */
export async function installOpencodeHooks(): Promise<void> {
  const bandPath = await findBand();
  const existing = readPlugin();
  if (existing !== null && !isBandPlugin(existing)) {
    throw new Error(
      `${opencodePluginPath()} exists and is not Band's; move it before installing hooks.`,
    );
  }
  mkdirSync(pluginsDir(), { recursive: true });
  writeTextAtomic(opencodePluginPath(), opencodePluginSource(bandPath));
}

/** Deletes the plugin file when it is Band's. */
export async function removeOpencodeHooks(): Promise<void> {
  const existing = readPlugin();
  if (existing === null || !isBandPlugin(existing)) return;
  unlinkSync(opencodePluginPath());
}
