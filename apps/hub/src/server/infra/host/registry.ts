import type { Host, TerminalBackend } from "@band-app/host-api";
import { LocalHost } from "@band-app/host-local";
import { ProjectQueries } from "../db/queries/projects";
import { WorkspaceQueries } from "../db/queries/workspaces";

const workspaceQueries = new WorkspaceQueries();
const projectQueries = new ProjectQueries();

/**
 * Finds the host a workspace or project lives on. A workspace's host is the
 * `worktrees.host_id` column. Every row is `local` until the hub can register
 * other machines, and a workspace with no row is treated as local.
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

  hostFor(workspaceId: string): Host {
    // With only the local host there is nothing to look up.
    if (this.hosts.size === 1) return this.local;
    return this.hostById(workspaceQueries.findHostId(workspaceId) ?? this.local.id);
  }

  /**
   * The host a project's main checkout is on for hub-wide work (sync, GitHub
   * polling). That is always the local host: a remote checkout only holds the
   * worktrees workspaces on that host use, and {@link projectPathOn} finds it.
   */
  hostForProject(_projectName: string): Host {
    return this.local;
  }

  /**
   * Where a project's checkout is on a host. `fallback` (the project's own
   * path) answers for the local host, and a remote host answers from
   * `project_hosts`. Null when the project has no checkout on that host.
   */
  projectPathOn(projectName: string, hostId: string, fallback: string): string | null {
    if (hostId === this.local.id) return fallback;
    return projectQueries.findHostPath(projectName, hostId);
  }

  /** Records a project's checkout on a remote host. */
  setProjectPathOn(projectName: string, hostId: string, path: string): void {
    projectQueries.setHostPath(projectName, hostId, path);
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
 * workspace service that depends on the registry.
 */
export function setLocalTerminalBackend(backend: TerminalBackend): TerminalBackend | null {
  const previous = terminalBackend;
  terminalBackend = backend;
  return previous;
}

export const hostRegistry = new HostRegistry(
  new LocalHost({
    terminalBackend: () => {
      if (!terminalBackend) throw new Error("The terminal backend has not been set up yet");
      return terminalBackend;
    },
  }),
);
