import { toWorktreeId } from "./worktree-id.ts";

const LOCAL_HOST_ID = "local";

/** The longest custom title `worktrees.setTitle` accepts. */
export const WORKTREE_TITLE_MAX = 100;

export interface DisplayHost {
  id: string;
  name?: string | null;
}

export interface DisplayRepo {
  name: string;
  worktrees: ReadonlyArray<{ name: string; hostId?: string | null; title?: string | null }>;
}

export interface WorktreeDisplay {
  /** The repo name, or null when the worktree is not in the list. */
  repo: string | null;
  /** What to show for the worktree: its custom title, else its name. */
  name: string;
  /** The name of the host, or null for the hub's own host. */
  host: string | null;
  /** `repo · name`, plus ` on host` for a worktree on another host. */
  label: string;
}

/** The name of a host. An unknown host id reads "unknown worker", never the raw id. */
export function hostDisplay(
  hostId: string | null | undefined,
  hosts: readonly DisplayHost[] | undefined,
): string {
  if (!hostId || hostId === LOCAL_HOST_ID) {
    return hosts?.find((h) => h.id === LOCAL_HOST_ID)?.name?.trim() || "This hub";
  }
  return hosts?.find((h) => h.id === hostId)?.name?.trim() || "unknown worker";
}

/**
 * What a person reads for a worktree id: repo and worktree name, and the host's name when it is
 * not the hub's own. The id stays in URLs, keys and data attributes.
 */
export function worktreeDisplay(
  worktreeId: string,
  repos: readonly DisplayRepo[] | undefined,
  hosts: readonly DisplayHost[] | undefined,
): WorktreeDisplay {
  for (const repo of repos ?? []) {
    for (const wt of repo.worktrees) {
      if (toWorktreeId(repo.name, wt.name, wt.hostId) === worktreeId) {
        const onOtherHost = !!wt.hostId && wt.hostId !== LOCAL_HOST_ID;
        const host = onOtherHost ? hostDisplay(wt.hostId, hosts) : null;
        return {
          repo: repo.name,
          name: wt.title || wt.name,
          host,
          label: `${repo.name} · ${wt.title || wt.name}${host ? ` on ${host}` : ""}`,
        };
      }
    }
  }
  // Not in the list (still loading, or removed): drop the host suffix from the id.
  const at = worktreeId.lastIndexOf("@");
  const hostId = at >= 0 ? worktreeId.slice(at + 1) : null;
  const base = at >= 0 ? worktreeId.slice(0, at) : worktreeId;
  const host = hostId ? hostDisplay(hostId, hosts) : null;
  return { repo: null, name: base, host, label: host ? `${base} on ${host}` : base };
}
