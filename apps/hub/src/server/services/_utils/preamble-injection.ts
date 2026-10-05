/**
 * How each coding agent takes the session preamble (plan step 5.3). The
 * mechanisms come from the adapters' sources, not from guesses:
 *
 * - `claude-code` (claude-agent-acp): `_meta.systemPrompt.append` on `session/new`,
 *   `session/load` and `session/resume` adds text to Claude Code's system prompt, and
 *   `_meta.claudeCode.options.settings` is passed to the SDK as flag settings, which accept
 *   `autoMemoryDirectory`.
 * - `codex` (codex-acp): the `CODEX_CONFIG` environment variable is a JSON object merged into
 *   the session config of the process, and `developer_instructions` is a Codex config key.
 * - Any other agent has no mechanism we have checked, so it gets nothing.
 */

export interface SessionPreamble {
  text: string;
  memoryDir: string | null;
}

export interface PreambleInjection {
  /** `_meta` for `session/new`, `session/load` and `session/resume`. */
  sessionMeta?: Record<string, unknown>;
  /** Environment for the agent process. */
  env?: Record<string, string>;
}

export function injectionFor(
  agentType: string,
  preamble: SessionPreamble,
  baseEnv: Record<string, string | undefined> = {},
): PreambleInjection | null {
  if (agentType === "claude-code") {
    const meta: Record<string, unknown> = {};
    if (preamble.text) meta.systemPrompt = { append: preamble.text };
    if (preamble.memoryDir) {
      meta.claudeCode = {
        options: { settings: { autoMemoryDirectory: preamble.memoryDir } },
      };
    }
    return Object.keys(meta).length > 0 ? { sessionMeta: meta } : null;
  }
  if (agentType === "codex") {
    if (!preamble.text) return null;
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = baseEnv.CODEX_CONFIG ? JSON.parse(baseEnv.CODEX_CONFIG) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // A broken CODEX_CONFIG already stops the adapter. Leave it alone rather than hide that.
      return null;
    }
    const existing =
      typeof config.developer_instructions === "string" ? config.developer_instructions : "";
    config.developer_instructions = existing ? `${existing}\n\n${preamble.text}` : preamble.text;
    return { env: { CODEX_CONFIG: JSON.stringify(config) } };
  }
  return null;
}
