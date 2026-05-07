import { homedir } from "node:os";

/**
 * Resolve the *highest-priority global* skills directory for a coding-agent
 * `type` — i.e. where new SKILL.md files should be installed so the agent
 * picks them up with maximum precedence (over lower-tier global fallbacks
 * but still below project-level skills).
 *
 * The actual path is owned by each agent's adapter file
 * (`adapters/<agent>.ts::get<Agent>InstallSkillsDir`) so the filesystem
 * convention lives next to the discovery logic that already reads from it.
 * This dispatcher uses dynamic imports — same pattern as `factory.ts` —
 * so callers don't pay the cost of loading every adapter (and its SDK
 * dependencies) just to look up a single path.
 *
 * Returns `null` for agent types that have no documented global skills
 * directory (e.g. `cursor-cli`).
 */
export async function getInstallSkillsDir(
  type: string,
  home: string = homedir(),
): Promise<string | null> {
  switch (type) {
    case "claude-code": {
      const { getClaudeCodeInstallSkillsDir } = await import("./adapters/claude-code.js");
      return getClaudeCodeInstallSkillsDir(home);
    }
    case "codex": {
      const { getCodexInstallSkillsDir } = await import("./adapters/codex.js");
      return getCodexInstallSkillsDir(home);
    }
    case "openai-codex": {
      const { getOpenAICodexInstallSkillsDir } = await import("./adapters/openai-codex.js");
      return getOpenAICodexInstallSkillsDir(home);
    }
    case "gemini-cli": {
      const { getGeminiCliInstallSkillsDir } = await import("./adapters/gemini-cli.js");
      return getGeminiCliInstallSkillsDir(home);
    }
    case "opencode": {
      const { getOpenCodeInstallSkillsDir } = await import("./adapters/opencode.js");
      return getOpenCodeInstallSkillsDir(home);
    }
    default:
      // `cursor-cli` and any future unknown type → caller treats as "no
      // destination" and skips. Do not throw: the install path runs on
      // every server boot and we don't want a new agent type to crash
      // setup before its adapter is wired up.
      return null;
  }
}
