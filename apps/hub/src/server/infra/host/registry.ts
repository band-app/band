import type { Host, TerminalBackend } from "@band-app/host-api";
import { WorkspaceQueries } from "../db/queries/workspaces";
import { LocalHost } from "./local-host";

const workspaceQueries = new WorkspaceQueries();

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

  hostById(hostId: string): Host {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`Unknown host "${hostId}"`);
    return host;
  }

  hostFor(workspaceId: string): Host {
    return this.hostById(workspaceQueries.findHostId(workspaceId) ?? this.local.id);
  }

  hostForProject(_projectName: string): Host {
    return this.local;
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
