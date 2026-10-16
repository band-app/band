/**
 * How far the agents on a host may reach through the worker relay. An admin person sets it per
 * host (`hosts.setTrust`); the hub reads it on every relay call, so lowering it takes effect at once.
 *
 * - `restricted`: only the agent's own worktrees (chats, tasks, terminals, browsers, queue).
 * - `standard`: the relay as it was before trust levels (own host, worktree creation elsewhere
 *   when `agents.crossHostWorktrees` allows it).
 * - `admin`: any host, hub settings, repo management and cronjobs of any scope.
 */
export const HOST_TRUST_LEVELS = ["restricted", "standard", "admin"] as const;
export type HostTrust = (typeof HOST_TRUST_LEVELS)[number];

export function isHostTrust(value: unknown): value is HostTrust {
  return typeof value === "string" && (HOST_TRUST_LEVELS as readonly string[]).includes(value);
}

/** The level a host has when nobody has set one: runner-started and ephemeral hosts are restricted. */
export function defaultHostTrust(host: { ephemeral: boolean }): HostTrust {
  return host.ephemeral ? "restricted" : "standard";
}
