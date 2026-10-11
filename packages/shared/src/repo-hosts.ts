/** The hub's own host. Same id `toWorktreeId` treats as the hub's machine. */
const LOCAL_HOST_ID = "local";

/**
 * The hosts a repo may run on. `null` (or an absent list) means every host. An empty list is
 * not stored: the API refuses it, so a repo always has at least one host it can use.
 */
export type AllowedHosts = readonly string[] | null | undefined;

/** Whether a repo limited to `allowed` may have worktrees, clones and placement on `hostId`. */
export function isHostAllowed(allowed: AllowedHosts, hostId: string | null | undefined): boolean {
  if (!allowed) return true;
  return allowed.includes(hostId || LOCAL_HOST_ID);
}

/**
 * The host whose default-branch checkout a repo lists as a worktree. The stored primary wins
 * while the repo may still run there. Otherwise it is the first host that holds a default-branch
 * checkout (the hub's own machine first, then by host id), so an older repo with no stored
 * primary and several clones shows exactly one.
 */
export function effectivePrimaryHost(
  primaryHostId: string | null | undefined,
  allowed: AllowedHosts,
  hostsWithDefaultCheckout: readonly string[],
): string | null {
  if (primaryHostId && isHostAllowed(allowed, primaryHostId)) return primaryHostId;
  const candidates = hostsWithDefaultCheckout.filter((id) => isHostAllowed(allowed, id));
  if (candidates.length === 0) return null;
  if (candidates.includes(LOCAL_HOST_ID)) return LOCAL_HOST_ID;
  return [...candidates].sort()[0] ?? null;
}

/** "<repo> is only available on <host names>", the message every refusal starts with. */
export function onlyAvailableOnMessage(repo: string, hostNames: readonly string[]): string {
  return `${repo} is only available on ${hostNames.join(", ")}`;
}

/**
 * Whether the hub keeps checkpoints of a repo's worktrees on static workers. A stored choice
 * wins. Without one, a repo available on every host is checkpointed and a repo limited to chosen
 * hosts is not, because limiting a repo usually means its code must stay off other machines.
 */
export function checkpointsEnabledFor(
  stored: boolean | null | undefined,
  allowed: AllowedHosts,
): boolean {
  if (stored != null) return stored;
  return !allowed;
}
