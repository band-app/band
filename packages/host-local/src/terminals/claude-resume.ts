import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resumeCliInvocation } from "@band-app/coding-agent";
import { claudeProjectSlug } from "@band-app/shared/claude-session";

/**
 * Cold-restore agent resume for a terminal whose hub gave no session id: the
 * newest Claude Code transcript in the folder. When the hub knows the
 * agent's session id it passes the resume command itself
 * (`SpawnOptions.resumeCommand`) and this file is not used. A pane that was
 * running something else gets scrollback + cwd restored, with no command re-run.
 */

/** The command's first shell word: a quoted path, or a run of non-blanks. */
const FIRST_WORD_PATTERN = /^('[^']*'|"[^"]*"|\S+)/;
const CLAUDE_RESUME_FLAG_PATTERN = /(^|\s)(--resume|-r)(\s|$)/;
/**
 * Claude Code names session transcripts `<uuid>.jsonl`. Enforced before a
 * filename stem is ever used as a "session id": that stem is spliced
 * unescaped into a shell command (`buildClaudeResumeCommand`) and `source`d
 * into the pane's shell, so anything else on disk under
 * `~/.claude/projects/<cwd slug>/*.jsonl` — including a filename crafted
 * with shell metacharacters, which POSIX permits — must never reach there.
 */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The binary a plain `claude` command runs: its first word, as written (so
 * a quoted path stays quoted), or null when the command is not `claude` or
 * an absolute or relative path ending in `claude`.
 */
export function claudeBinaryOf(command: string | undefined): string | null {
  if (!command) return null;
  const word = FIRST_WORD_PATTERN.exec(command.trim())?.[1];
  if (!word) return null;
  const path = word.replace(/^['"]|['"]$/g, "");
  return basename(path) === "claude" ? word : null;
}

/** Was `command` a plain `claude` invocation, not already asking to resume something? */
export function isResumableClaudeCommand(command: string | undefined): boolean {
  if (!command) return false;
  return claudeBinaryOf(command) !== null && !CLAUDE_RESUME_FLAG_PATTERN.test(command.trim());
}

/** Claude Code's own convention: `~/.claude/projects/<slug of cwd>/<uuid>.jsonl`. */
function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", claudeProjectSlug(cwd));
}

/** The newest Claude Code session transcript for `cwd`, if any. */
export function findLatestClaudeSessionId(cwd: string): string | null {
  const dir = claudeProjectDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let newest: { id: string; mtimeMs: number } | null = null;
  for (const name of names) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue; // Removed between readdir and stat.
    }
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { id: name.slice(0, -".jsonl".length), mtimeMs };
    }
  }
  if (!newest || !SESSION_ID_PATTERN.test(newest.id)) return null;
  return newest.id;
}

/**
 * `<binary> --resume <id>` and nothing else. The original command's
 * arguments are dropped on purpose: a session launched as `claude '<prompt>'`
 * would otherwise send the prompt again. `binary` is already shell-safe
 * (taken from the saved command) and `sessionId` matches `SESSION_ID_PATTERN`.
 */
export function buildClaudeResumeCommand(binary: string, sessionId: string): string {
  const invocation = resumeCliInvocation("claude-code", sessionId, { command: binary });
  if (invocation.unsupported) throw new Error(invocation.reason);
  return [invocation.command, ...invocation.args].join(" ");
}
