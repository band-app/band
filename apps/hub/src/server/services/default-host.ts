/**
 * Where a new worktree goes when the caller named no worker and asked for no placement: the
 * repo's primary worker when it is allowed and online, else the old default (the caller's own
 * worker, or `resolveWorktreeHostId`). A primary that cannot be used falls back with a notice.
 */

import { isHostAllowed } from "@band-app/shared/repo-hosts";
import { isLocalHostEnabled } from "../infra/host/local-host-enabled";
import { hostNamesOf, primaryHostOf } from "./_utils/repo-host-policy";
import { crossHostRefusal } from "./cross-host-policy";
import { LOCAL_HOST_ID, resolveWorktreeHostId } from "./local-host-policy";
import { tokenService } from "./token-service";

export interface DefaultHostChoice {
  hostId: string;
  /** Why the repo's primary worker was not used, when it was set but could not be. */
  notice?: string;
}

interface RepoForDefault {
  name: string;
  defaultBranch: string;
  allowedHostIds?: string[] | null;
  primaryHostId?: string | null;
  worktrees: {
    name: string;
    branch: string;
    hostId?: string | null;
    supersededBy?: string | null;
  }[];
}

export function resolveDefaultHost(
  repo: RepoForDefault,
  callerHostId: string | undefined,
): DefaultHostChoice {
  const fallback = (reason?: string): DefaultHostChoice => {
    const hostId = resolveWorktreeHostId(callerHostId);
    if (!reason) return { hostId };
    return {
      hostId,
      notice: `${reason}; created on ${hostNamesOf([hostId])[0] ?? hostId}`,
    };
  };
  const stored = repo.primaryHostId ?? null;
  const primary = primaryHostOf(repo);
  if (!primary) return fallback();
  const primaryName = hostNamesOf([primary])[0] ?? primary;
  if (stored && !isHostAllowed(repo.allowedHostIds ?? null, stored)) {
    const storedName = hostNamesOf([stored])[0] ?? stored;
    return fallback(`primary worker ${storedName} is not allowed for ${repo.name}`);
  }
  if (primary === LOCAL_HOST_ID) {
    // The hub's own machine: skip it when turned off. Another worker's agent cannot use it.
    if (!isLocalHostEnabled()) return fallback();
  } else {
    const row = tokenService.listHosts(1000).find((h) => h.id === primary);
    if (!row || row.status !== "online") {
      return fallback(`primary worker ${primaryName} is ${row?.status ?? "unknown"}`);
    }
  }
  if (callerHostId && primary !== callerHostId) {
    const refusal = crossHostRefusal(repo.name, primary, callerHostId);
    if (refusal !== null)
      return fallback(`primary worker ${primaryName} is unavailable (${refusal})`);
  }
  return { hostId: primary };
}
