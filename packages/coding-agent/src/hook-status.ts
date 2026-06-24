import type { AgentHookStatus } from "./types.js";

/**
 * Map a coding agent's lifecycle-notification payload (the JSON its hook pipes
 * to `band notify` on stdin) to a Band workspace status.
 *
 * The per-agent translation lives in each adapter
 * (`adapters/<agent>.ts::map<Agent>HookStatus`) so the interpretation of an
 * agent's hook events sits next to the rest of that agent's logic. This
 * dispatcher uses dynamic imports — same pattern as `factory.ts` and
 * `install-skills.ts` — so callers don't load every adapter (and its SDK
 * dependencies) just to map one payload.
 *
 * Adding hook support for a new agent therefore means: add a mapper to its
 * adapter and a case here. The Band CLI never changes — it forwards the raw
 * payload and the server dispatches.
 *
 * Agent types without a hook integration (no `case` below) default to
 * `working`: a notification arrived, so the agent is at least active. Today
 * only Claude Code registers hooks, so other types only reach this path in
 * unusual setups.
 */
export async function mapHookPayloadToStatus(
  agentType: string,
  payload: Record<string, unknown>,
): Promise<AgentHookStatus> {
  switch (agentType) {
    case "claude-code": {
      const { mapClaudeCodeHookStatus } = await import("./adapters/claude-code.js");
      return mapClaudeCodeHookStatus(payload);
    }
    default:
      return "working";
  }
}
