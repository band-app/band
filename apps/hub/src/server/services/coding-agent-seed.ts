import { createLogger } from "@band-app/logger";
import { type CodingAgentDefinition, loadSettings, saveSettings } from "./state";

const log = createLogger("coding-agent-seed");

// Coding agents Band knows by default, in priority order. The first one found
// becomes the default agent if none has been chosen yet.
export const AGENT_CHECKS: { id: string; type: string; label: string; binary: string }[] = [
  { id: "claude-code", type: "claude-code", label: "Claude Code", binary: "claude" },
  { id: "codex", type: "codex", label: "Codex", binary: "codex" },
  { id: "opencode", type: "opencode", label: "OpenCode", binary: "opencode" },
];

/**
 * Fills an empty `codingAgents` list from the agent types a worker reports. A hub on a
 * server has no agent CLIs of its own, so boot detection finds none and the UI would
 * list no agents and resolve no icons until the list is filled. A list the user already
 * has is never touched.
 */
export function seedCodingAgentsFromTypes(types: readonly string[]): void {
  const settings = loadSettings();
  if (Array.isArray(settings.codingAgents) && settings.codingAgents.length > 0) return;
  const seeded: CodingAgentDefinition[] = AGENT_CHECKS.filter((c) => types.includes(c.type)).map(
    ({ id, type, label }) => ({ id, type, label }),
  );
  if (seeded.length === 0) return;
  settings.codingAgents = seeded;
  if (!settings.defaultCodingAgent) settings.defaultCodingAgent = seeded[0].id;
  saveSettings(settings);
  log.info(
    "Enabled %d coding agent(s) from a worker; default = %s",
    seeded.length,
    settings.defaultCodingAgent,
  );
}
