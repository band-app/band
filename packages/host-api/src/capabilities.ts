import type { AgentCapability } from "./host";

/** Whether a reported agent can run work: installed and, when the host can tell, logged in. */
export function agentIsUsable(a: AgentCapability | undefined): boolean {
  return Boolean(a?.installed) && a?.loggedIn !== false;
}
