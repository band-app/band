/**
 * What Claude Code's "Default" model and effort choices resolve to, so the
 * chat composer can show "Opus 5.5 Medium" instead of "Default Default".
 *
 * The Claude ACP adapter offers a `default` row in its model and effort
 * options. Picking it hands the choice back to the CLI, which resolves it
 * from, highest first:
 *
 *   - model: a `--model` flag, `ANTHROPIC_MODEL`, the `model` setting, then
 *     the account's default model.
 *   - effort: `CLAUDE_CODE_EFFORT_LEVEL`, an `--effort` flag, the model's
 *     entry in `modelSettings`, the top-level `effortLevel` setting, then the
 *     model's own default effort (a table inside the CLI).
 *
 * Settings merge from `~/.claude/settings.json`, the project's
 * `.claude/settings.json` and `.claude/settings.local.json`, any `--settings`
 * file on the CLI's command line (a wrapper script such as one that points
 * Claude Code at a gateway adds one), and managed settings. A settings file's
 * `env` block sets environment variables for the CLI.
 *
 * The running session is the better source: the CLI writes the model and the
 * effort it used on every assistant record of its transcript,
 * `~/.claude/projects/<cwd slug>/<session id>.jsonl`. That covers the model's
 * built-in default effort, which config can't tell.
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { ResolvedDefaults } from "../../../shared/chat-events";

/** Model and effort flags on the CLI's command line, and its `--settings`. */
export interface ClaudeCliArgs {
  /** Paths or inline JSON, in command-line order. */
  settings: string[];
  model?: string;
  effort?: string;
}

interface ClaudeSettings {
  model?: unknown;
  effortLevel?: unknown;
  modelSettings?: Record<string, { effortLevel?: unknown } | undefined>;
  env?: Record<string, unknown>;
}

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Transcript bytes read from the end: enough for the last assistant record. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** Session ids are spliced into a path. */
const SESSION_ID_PATTERN = /^[\w-]+$/;

function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function managedSettingsPath(): string | null {
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (process.platform === "linux") return "/etc/claude-code/managed-settings.json";
  return null;
}

function readSettings(source: string, cwd: string | undefined): ClaudeSettings | null {
  try {
    const text = source.trimStart().startsWith("{")
      ? source
      : readFileSync(resolvePath(cwd ?? homedir(), source.replace(/^~(?=\/)/, homedir())), "utf8");
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as ClaudeSettings) : null;
  } catch {
    return null; // Missing or malformed: the CLI skips it too.
  }
}

/** Settings in the CLI's precedence order, lowest first, merged. `env` and
 *  `modelSettings` merge per key; everything else is replaced. Without a
 *  `cwd` there are no project settings. */
function mergedSettings(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  extra: string[],
): ClaudeSettings {
  const sources = [
    join(claudeConfigDir(env), "settings.json"),
    cwd && join(cwd, ".claude", "settings.json"),
    cwd && join(cwd, ".claude", "settings.local.json"),
    ...extra,
    managedSettingsPath(),
  ];
  const merged: ClaudeSettings = {};
  for (const source of sources) {
    if (!source) continue;
    const s = readSettings(source, cwd);
    if (!s) continue;
    if (s.model !== undefined) merged.model = s.model;
    if (s.effortLevel !== undefined) merged.effortLevel = s.effortLevel;
    if (s.modelSettings && typeof s.modelSettings === "object") {
      merged.modelSettings = { ...merged.modelSettings, ...s.modelSettings };
    }
    if (s.env && typeof s.env === "object") merged.env = { ...merged.env, ...s.env };
  }
  return merged;
}

function effortLevel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const level = value.trim().toLowerCase();
  if (level === "med") return "medium";
  return EFFORT_LEVELS.has(level) ? level : undefined;
}

function modelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  return model && model.toLowerCase() !== "default" ? model : undefined;
}

/** `claude-opus-5-5-20260101[1m]` → `opus-5-5`, for matching settings keys. */
function modelKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[\d+m\]$|-\d+m$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/, "");
}

/** The model's `modelSettings` entry. Keys are canonical model names; a bare
 *  alias (`opus`) matches the one entry of its family, if there is one. */
function perModelEffort(settings: ClaudeSettings, model: string | undefined): string | undefined {
  if (!model || !settings.modelSettings) return undefined;
  const key = modelKey(model);
  const entries = Object.entries(settings.modelSettings);
  const exact = entries.find(([k]) => modelKey(k) === key);
  if (exact) return effortLevel(exact[1]?.effortLevel);
  const family = entries.filter(([k]) => modelKey(k).startsWith(`${key}-`));
  return family.length === 1 ? effortLevel(family[0]?.[1]?.effortLevel) : undefined;
}

/** What config says the defaults are, before any session reports them. */
export function configuredClaudeDefaults(opts: {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  cli?: ClaudeCliArgs;
}): ResolvedDefaults {
  const settings = mergedSettings(opts.cwd, opts.env, opts.cli?.settings ?? []);
  // A settings file's env block wins over the inherited environment.
  const envVar = (name: string) => {
    const fromSettings = settings.env?.[name];
    return typeof fromSettings === "string" ? fromSettings : opts.env[name];
  };
  const model =
    modelId(opts.cli?.model) ?? modelId(envVar("ANTHROPIC_MODEL")) ?? modelId(settings.model);
  const effort =
    effortLevel(envVar("CLAUDE_CODE_EFFORT_LEVEL")) ??
    effortLevel(opts.cli?.effort) ??
    perModelEffort(settings, model) ??
    effortLevel(settings.effortLevel);
  return { model, effort };
}

/** Claude Code's project directory name: the real path of the cwd (macOS
 *  `/tmp` is `/private/tmp`), every non-alphanumeric → `-`. */
function transcriptPath(env: NodeJS.ProcessEnv, cwd: string, sessionId: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // A removed worktree: its transcript can't be found either way.
  }
  return join(
    claudeConfigDir(env),
    "projects",
    real.replace(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
}

function readTail(path: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The model and effort of the session's last main-thread assistant record,
 * when it was written at or after `since` (ms). An older record predates the
 * last model or effort change, so it no longer describes the default.
 */
export function reportedClaudeDefaults(opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  since?: number;
}): ResolvedDefaults {
  if (!SESSION_ID_PATTERN.test(opts.sessionId)) return {};
  const tail = readTail(transcriptPath(opts.env, opts.cwd, opts.sessionId), TRANSCRIPT_TAIL_BYTES);
  if (!tail) return {};
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"assistant"')) continue;
    let record: {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      effort?: unknown;
      message?: { model?: unknown };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // The first line of the tail is usually cut.
    }
    const model = record.message?.model;
    if (record.type !== "assistant" || record.isSidechain === true) continue;
    // Error and interrupt records carry a placeholder model.
    if (typeof model !== "string" || model.startsWith("<")) continue;
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    if (opts.since !== undefined && !(at >= opts.since)) return {};
    return { model, effort: effortLevel(record.effort) };
  }
  return {};
}

function flagValue(args: string[], i: number, flag: string): string | undefined {
  const arg = args[i];
  if (arg === flag) return args[i + 1];
  if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  return undefined;
}

/** Reads `--settings`, `--model` and `--effort` off a command line. Arguments
 *  are split on whitespace, the way `ps` prints them. */
export function parseClaudeCliArgs(commandLine: string): ClaudeCliArgs {
  const args = commandLine.split(/\s+/).filter(Boolean);
  const out: ClaudeCliArgs = { settings: [] };
  for (let i = 0; i < args.length; i++) {
    const settings = flagValue(args, i, "--settings");
    if (settings) out.settings.push(settings);
    out.model = flagValue(args, i, "--model") ?? out.model;
    out.effort = flagValue(args, i, "--effort") ?? out.effort;
  }
  return out;
}

function listProcesses(): Promise<{ pid: number; ppid: number; args: string }[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,args="],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, out) => {
        if (err) return resolve([]);
        const rows = [];
        for (const line of out.split("\n")) {
          const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
          if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? "" });
        }
        resolve(rows);
      },
    );
  });
}

/**
 * The command-line flags of the Claude Code CLI running `sessionId` under the
 * adapter process `rootPid`. The adapter starts the CLI (or the wrapper the
 * user configured, which then starts it) with the session id on its command
 * line. Returns null when there is no such process, or no `ps` (Windows).
 */
export async function findClaudeCliArgs(
  rootPid: number,
  sessionId: string,
): Promise<ClaudeCliArgs | null> {
  if (process.platform === "win32") return null;
  const rows = await listProcesses();
  const children = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const queue = [...(children.get(rootPid) ?? [])];
  let found: ClaudeCliArgs | null = null;
  while (queue.length > 0) {
    const row = queue.shift();
    if (!row) break;
    if (row.args.includes(sessionId)) {
      // A wrapper and the CLI it starts can both match; the deepest one
      // carries every flag the wrapper added.
      const args = parseClaudeCliArgs(row.args);
      found = found
        ? {
            settings: [
              ...found.settings,
              ...args.settings.filter((s) => !found?.settings.includes(s)),
            ],
            model: args.model ?? found.model,
            effort: args.effort ?? found.effort,
          }
        : args;
    }
    queue.push(...(children.get(row.pid) ?? []));
  }
  return found;
}
