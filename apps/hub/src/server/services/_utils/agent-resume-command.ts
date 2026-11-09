import { resumeCliInvocation } from "@band-app/coding-agent";
import { agentSessionRegistry } from "../agent-session-registry-service";
import { settingsService } from "../settings-service";
import { formatShellCommand } from "./format-shell-command";

/**
 * The command that resumes the agent a terminal last ran, for a cold
 * restore of that terminal (`SpawnOptions.resumeCommand`).
 *
 * - A string: the agent session's latest row names a provider session and
 *   the agent has a resume invocation. The binary is the worker's configured
 *   command for that agent, and the command has no prompt.
 * - `null`: nothing resumes. The user closed the terminal, the agent said
 *   its session ended, or the agent (Gemini, Cursor) has no resume.
 * - `undefined`: the hub knows nothing about this terminal's agent, so the
 *   pool falls back to the newest Claude Code transcript in the folder.
 *
 * Looks at the newest row whether it is open or not: a PTY lost to a daemon
 * crash can leave the row either way.
 */
export function resumeCommandFor(terminalId: string): string | null | undefined {
  const row = agentSessionRegistry.latestForTerminal(terminalId);
  if (!row || row.mode !== "tui") return undefined;
  if (row.endReason === "killed" || row.endReason === "session-end") return null;
  if (!row.providerSessionId) return undefined;
  const definition = settingsService
    .get()
    .codingAgents?.find((agent) => agent.id === row.agentDefinitionId);
  const invocation = resumeCliInvocation(
    definition?.type ?? row.agentDefinitionId,
    row.providerSessionId,
    { command: definition?.command },
  );
  if (invocation.unsupported) return null;
  return formatShellCommand(invocation.command, invocation.args);
}
