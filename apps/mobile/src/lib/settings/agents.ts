/**
 * The Agents screen: the configured agents, which one is the default, and where each can start.
 * Pure, so the tests run under Node.
 */

export interface AgentModelLike {
  id: string;
  name: string;
}

export interface AgentEntryLike {
  agentId: string;
  agentType: string;
  agentLabel: string;
  models: AgentModelLike[];
  defaultModel?: string;
}

export interface HostAvailabilityLike {
  hostId: string;
  hostName: string;
  available: boolean;
  reason?: string;
}

export interface AgentAvailabilityLike {
  agentId: string;
  hosts: HostAvailabilityLike[];
}

export function modelSummary(entry: AgentEntryLike): string {
  const count = entry.models.length;
  const defaultName = entry.models.find((m) => m.id === entry.defaultModel)?.name;
  const models = count === 1 ? "1 model" : `${count} models`;
  return defaultName ? `${models}, default ${defaultName}` : models;
}

export function availabilityFor(
  availability: readonly AgentAvailabilityLike[] | undefined,
  agentId: string,
): HostAvailabilityLike[] {
  return availability?.find((a) => a.agentId === agentId)?.hosts ?? [];
}

export function availabilityText(host: HostAvailabilityLike): string {
  if (host.available) return `${host.hostName}: ready`;
  return `${host.hostName}: ${host.reason ?? "unavailable"}`;
}

export interface RefreshResultLike {
  agentId?: string;
  error?: string;
}

/** One line after a refresh: the failures, or that it worked. */
export function refreshSummary(results: readonly RefreshResultLike[]): string {
  const failed = results.filter((r) => r.error);
  if (failed.length === 0) return "Models refreshed.";
  return failed.map((r) => `${r.agentId ?? "agent"}: ${r.error}`).join("\n");
}
