import { homedir } from "node:os";
import { join } from "node:path";

/** Default executable names (looked up via PATH) for each coding agent. */
export const CLAUDE_CODE_DEFAULT_BINARY = "claude";
export const CODEX_DEFAULT_BINARY = "codex";
export const GEMINI_CLI_DEFAULT_BINARY = "gemini";
export const OPENCODE_DEFAULT_BINARY = "opencode";

/**
 * Resolve the *highest-priority global* skills directory for a coding-agent
 * `type` — i.e. where new SKILL.md files should be installed so the agent
 * picks them up with maximum precedence (over lower-tier global fallbacks
 * but still below project-level skills).
 *
 *   - `claude-code` → `~/.claude/skills` (personal scope, see
 *     https://code.claude.com/docs/en/skills).
 *   - `codex` → `$CODEX_HOME/skills` (default `~/.codex/skills`; the
 *     `.system/` subfolder is reserved for OpenAI-shipped skills). Reads
 *     `CODEX_HOME` at call time so test overrides take effect. See
 *     https://developers.openai.com/codex/skills.
 *   - `gemini-cli` → `~/.gemini/skills` (not affected by workspace trust).
 *     See https://geminicli.com/docs/cli/skills/.
 *   - `opencode` → `~/.config/opencode/skills`, the highest-priority
 *     *global* entry in OpenCode's resolution order, so we don't pollute
 *     `~/.claude/skills/`. See https://opencode.ai/docs/skills/.
 *
 * Async for call-site compatibility with the earlier adapter-backed
 * dispatcher. Returns `null` for agent types that have no documented global
 * skills directory (e.g. `cursor-cli`).
 */
export async function getInstallSkillsDir(
  type: string,
  home: string = homedir(),
): Promise<string | null> {
  switch (type) {
    case "claude-code":
      return join(home, ".claude", "skills");
    case "codex":
      // `||` (not `??`) so an empty-string `$CODEX_HOME=` falls back to
      // `~/.codex` instead of returning `"/skills"`.
      return join(process.env.CODEX_HOME || join(home, ".codex"), "skills");
    case "gemini-cli":
      return join(home, ".gemini", "skills");
    case "opencode":
      return join(home, ".config", "opencode", "skills");
    default:
      // `cursor-cli` and any future unknown type → caller treats as "no
      // destination" and skips. Do not throw: the install path runs on
      // every server boot and we don't want a new agent type to crash
      // setup before it is wired up here.
      return null;
  }
}

/**
 * Resolve the default executable name (looked up via PATH) for a coding-agent
 * `type`. Used by callers to verify an agent listed in
 * `settings.codingAgents` is *actually installed* on the host before
 * touching its skills directory — an agent whose binary has been
 * uninstalled is effectively no longer enabled, even if it hasn't been
 * removed from settings yet.
 *
 * Returns `null` for agent types whose default binary name we don't know
 * (e.g. `cursor-cli`). Callers should treat that as "skip" rather than
 * fail-closed, matching the behavior of `getInstallSkillsDir`.
 */
export async function getDefaultAgentBinary(type: string): Promise<string | null> {
  switch (type) {
    case "claude-code":
      return CLAUDE_CODE_DEFAULT_BINARY;
    case "codex":
      return CODEX_DEFAULT_BINARY;
    case "gemini-cli":
      return GEMINI_CLI_DEFAULT_BINARY;
    case "opencode":
      return OPENCODE_DEFAULT_BINARY;
    default:
      return null;
  }
}

/**
 * The canonical, agent-agnostic location for Band's shipped skills. Each
 * skill is installed *once* as `~/.agents/skills/<name>/SKILL.md`; the
 * per-agent skill directories (e.g. `~/.claude/skills/<name>`) are then
 * created as directory-level symlinks pointing back here.
 *
 * The shared layout means:
 *
 *   1. Skill content lives in one place — editing a SKILL.md updates every
 *      agent that's been linked, without re-running the installer.
 *   2. No `mkdir`-then-copy fan-out across N agent directories on every
 *      boot. Idempotency simplifies to "is the symlink already correct?".
 *   3. The destination follows the tool-agnostic convention already
 *      documented by OpenCode and Gemini CLI as their lowest-priority
 *      shared skills root. Other agents that adopt the convention later
 *      only need a new entry in `SUPPORTED_AGENT_TYPES`.
 */
export function getSharedSkillsDir(home: string = homedir()): string {
  return join(home, ".agents", "skills");
}

/**
 * Agent types Band knows how to link into. Each entry must have an
 * install-skills dir (`getInstallSkillsDir` returns a non-null path) — otherwise there's nowhere to put the
 * symlink. `cursor-cli` is deliberately omitted because the Cursor CLI
 * has no documented user-scope skills directory at the time of writing.
 *
 * Order is informational only: the linker iterates this list once and
 * skips any agent that isn't detected on the host.
 */
export const SUPPORTED_AGENT_TYPES = ["claude-code", "codex", "gemini-cli", "opencode"] as const;

export type SupportedAgentType = (typeof SUPPORTED_AGENT_TYPES)[number];

/**
 * Filesystem path of the *parent* config directory the agent owns —
 * `~/.claude` for Claude Code, `~/.codex` for Codex, etc. Used by the
 * linker to detect "is this agent installed on this machine?" without
 * shelling out: if the directory exists, the agent has been configured
 * here at some point and is a legitimate link target.
 *
 * Returns `null` for unknown types so callers can no-op rather than
 * crash if the supported-agents list ever drifts ahead of the switch.
 *
 * Note: for `codex`, `$CODEX_HOME` takes precedence over `home` when set —
 * callers that need full isolation (e.g. test sandboxes) must also control
 * the `CODEX_HOME` environment variable. The matching Rust helper
 * (`apps/cli/src/skills.rs::codex_home`) has the same behaviour.
 */
export function getAgentConfigDir(type: string, home: string = homedir()): string | null {
  switch (type) {
    case "claude-code":
      return join(home, ".claude");
    case "codex":
      // Honor `$CODEX_HOME` (default `~/.codex`) at call time so test
      // overrides take effect. Use `||` instead of `??` so an empty-string
      // `$CODEX_HOME=` is treated as unset rather than being returned as
      // `""` (which would explode at the first `statSync`). Matches the
      // Rust `codex_home()` helper's `!val.is_empty()` check.
      return process.env.CODEX_HOME || join(home, ".codex");
    case "gemini-cli":
      return join(home, ".gemini");
    case "opencode":
      return join(home, ".config", "opencode");
    default:
      return null;
  }
}
