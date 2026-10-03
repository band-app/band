import type { Host, TerminalBackend } from "@band-app/host-api";
import { LocalHost } from "./local-host";

/**
 * Finds the host a workspace or project lives on. Every workspace lives on the
 * local host until the hub can place work on other machines.
 */
export class HostRegistry {
  constructor(readonly local: Host) {}

  hostFor(_workspaceId: string): Host {
    return this.local;
  }

  hostForProject(_projectName: string): Host {
    return this.local;
  }

  /** Every host the hub can place work on. */
  all(): Host[] {
    return [this.local];
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
