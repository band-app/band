import type { Host, TerminalBackend } from "@band-app/host-api";
import { LocalHost } from "@band-app/host-local";
import { RepoQueries } from "../db/queries/repos";
import { WorktreeQueries } from "../db/queries/worktrees";

const worktreeQueries = new WorktreeQueries();
const repoQueries = new RepoQueries();

/**
 * Finds the host a worktree or repo lives on. A worktree's host is the
 * `worktrees.host_id` column. Every row is `local` until the hub can register
 * other machines, and a worktree with no row is treated as local.
 */
export class HostRegistry {
  private readonly hosts = new Map<string, Host>();

  constructor(readonly local: Host) {
    this.hosts.set(local.id, local);
  }

  /** Makes a host resolvable by the id stored in `host_id` columns. */
  register(host: Host): void {
    this.hosts.set(host.id, host);
  }

  /** Forgets a host that was removed. The local host cannot be removed. */
  unregister(hostId: string): void {
    if (hostId !== this.local.id) this.hosts.delete(hostId);
  }

  hostById(hostId: string): Host {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`Unknown host "${hostId}"`);
    return host;
  }

  hostFor(worktreeId: string): Host {
    // With only the local host there is nothing to look up.
    if (this.hosts.size === 1) return this.local;
    return this.hostById(this.hostIdOfScope(worktreeId) ?? this.local.id);
  }

  /** The host id of a worktree, or null when it has no row (local). */
  hostIdOfScope(scopeId: string): string | null {
    return worktreeQueries.findHostId(scopeId);
  }

  /**
   * The host a repo's main checkout is on for hub-wide work (sync, GitHub
   * polling). That is always the local host: a remote checkout only holds the
   * worktrees worktrees on that host use, and {@link repoPathOn} finds it.
   */
  hostForRepo(_repoName: string): Host {
    return this.local;
  }

  /**
   * Where a repo's checkout is on a host. `fallback` (the repo's own
   * path) answers for the local host, and a remote host answers from
   * `repo_hosts`. Null when the repo has no checkout on that host.
   */
  repoPathOn(repoName: string, hostId: string, fallback: string): string | null {
    if (hostId === this.local.id) return fallback;
    return repoQueries.findHostPath(repoName, hostId);
  }

  /** Records a repo's checkout on a remote host. */
  setRepoPathOn(repoName: string, hostId: string, path: string): void {
    repoQueries.setHostPath(repoName, hostId, path);
  }

  /** Every host the hub can place work on. */
  all(): Host[] {
    return [...this.hosts.values()];
  }
}

let terminalBackend: TerminalBackend | null = null;

/**
 * Called by `TerminalService` whenever it picks the local backend, so
 * `local.pty` is the backend the terminal service uses. Returns the backend it
 * replaced. The registry can't import the service, which depends on the
 * worktree service that depends on the registry.
 */
export function setLocalTerminalBackend(backend: TerminalBackend): TerminalBackend | null {
  const previous = terminalBackend;
  terminalBackend = backend;
  return previous;
}

export const hostRegistry = new HostRegistry(
  new LocalHost({
    // `gh` is the GitHub plugin's tool: with that plugin disabled the host never runs it. The
    // import is dynamic because the services import this registry.
    ghEnabled: async () => {
      const { loadSettings } = await import("../../services/state");
      return !(loadSettings().plugins?.disabled ?? []).includes("github");
    },
    terminalBackend: () => {
      if (!terminalBackend) throw new Error("The terminal backend has not been set up yet");
      return terminalBackend;
    },
  }),
);
