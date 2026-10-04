/**
 * Whether workspaces may run on the hub's own machine. `BAND_LOCAL_HOST=off`
 * (read on every call) turns it off, for a hub on a server where every
 * workspace belongs on a worker. A new workspace with no host then goes to
 * `BAND_DEFAULT_HOST`, or to the only online worker.
 */

import { isLocalHostEnabled } from "../infra/host/local-host-enabled";
import { tokenService } from "./token-service";

export const LOCAL_HOST_ID = "local";

export class LocalHostDisabledError extends Error {
  constructor() {
    super(
      "Workspaces on the hub's own machine are turned off (BAND_LOCAL_HOST=off). Choose a worker host.",
    );
    this.name = "LocalHostDisabledError";
  }
}

export class NoDefaultHostError extends Error {
  constructor(reason: string) {
    super(
      `${reason} Workspaces on the hub's own machine are turned off (BAND_LOCAL_HOST=off), so pass a hostId or set BAND_DEFAULT_HOST.`,
    );
    this.name = "NoDefaultHostError";
  }
}

/** The host a workspace goes on when the caller named none. */
export function resolveWorkspaceHostId(requested: string | undefined): string {
  if (!isLocalHostEnabled()) {
    if (requested === LOCAL_HOST_ID) throw new LocalHostDisabledError();
    if (requested) return requested;
    const configured = process.env.BAND_DEFAULT_HOST?.trim();
    if (configured) {
      if (configured === LOCAL_HOST_ID) throw new LocalHostDisabledError();
      return configured;
    }
    const online = tokenService
      .listHosts()
      .filter((h) => h.id !== LOCAL_HOST_ID && h.status === "online");
    if (online.length === 1) return online[0].id;
    throw new NoDefaultHostError(
      online.length === 0 ? "No worker is online." : "More than one worker is online.",
    );
  }
  return requested ?? LOCAL_HOST_ID;
}
