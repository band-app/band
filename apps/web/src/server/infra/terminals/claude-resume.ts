import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Cold-restore agent resume, scoped to Claude Code only (see the terminal
 * daemon resilience PR discussion): Claude Code's on-disk session layout is
 * stable and documented, so a saved session id can be trusted; other agents'
 * formats weren't verified and are left as a follow-up rather than guessed
 * at. A pane that was running something else just gets scrollback + cwd
 * restored, with no command re-run.
 */

const CLAUDE_COMMAND_PATTERN = /^claude(\s|$)/;
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

/** Was `command` a plain `claude` invocation, not already asking to resume something? */
export function isResumableClaudeCommand(command: string | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  return CLAUDE_COMMAND_PATTERN.test(trimmed) && !CLAUDE_RESUME_FLAG_PATTERN.test(trimmed);
}

/** Claude Code's own convention: `~/.claude/projects/<cwd with "/" -> "-">/<uuid>.jsonl`. */
function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replaceAll("/", "-"));
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

export function buildClaudeResumeCommand(originalCommand: string, sessionId: string): string {
  return `${originalCommand.trim()} --resume ${sessionId}`;
}
