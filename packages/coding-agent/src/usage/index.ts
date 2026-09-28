import { claudeCodeUsageReader } from "./claude-code.ts";
import { codexUsageReader } from "./codex.ts";
import { createOpenCodeUsageReader } from "./opencode.ts";
import type { UsageReader } from "./types.ts";

export { encodeClaudeProjectDir } from "./claude-code.ts";
export type { UsageReader, UsageSessionItem } from "./types.ts";

/**
 * Resolve the Reports usage reader for a coding-agent type (issue #425).
 *
 * `opts.command` is the agent definition's `command` field; only OpenCode
 * uses it, because its sessions are read through the `opencode` binary
 * rather than from files. Returns `undefined` for agents whose provider
 * doesn't persist usage data (`gemini-cli`, `cursor-cli`) and for unknown
 * types — the scanner skips those.
 */
export function getUsageReader(
  agentType: string,
  opts?: { command?: string },
): UsageReader | undefined {
  switch (agentType) {
    case "claude-code":
      return claudeCodeUsageReader;
    case "codex":
      return codexUsageReader;
    case "opencode":
      return createOpenCodeUsageReader(opts?.command || undefined);
    default:
      return undefined;
  }
}
