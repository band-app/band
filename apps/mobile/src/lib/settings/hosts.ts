/**
 * What the Hosts screen shows for a row of `hosts.list`. Pure, so the tests run under Node.
 */

import { relativeTime } from "@band-app/client/merge";

export interface HostUpdateLike {
  state: "installing" | "restarting" | "failed";
  target?: string;
  error?: string;
}

export interface HostLike {
  id: string;
  name: string;
  status: string;
  lastSeenAt: number | null;
  usable?: boolean;
  workerVersion?: string | null;
  versionState?: "current" | "ahead" | "behind" | "unknown" | "refused";
  updateRequired?: string | null;
  updateTarget?: string | null;
  canUpdate?: boolean;
  manualCommand?: string | null;
  update?: HostUpdateLike | null;
}

const VERSION_STATE_LABEL = {
  current: null,
  ahead: "ahead of the hub",
  behind: "behind the hub",
  unknown: "version unknown, update recommended",
  refused: "update required",
} as const;

export function versionStateLabel(host: HostLike): string | null {
  return host.versionState ? VERSION_STATE_LABEL[host.versionState] : null;
}

export function versionText(host: HostLike): string {
  return `Version ${host.workerVersion ?? "unknown"}`;
}

/** "Last seen 3 minutes ago", or "Never seen". */
export function lastSeenText(host: HostLike, now = Date.now()): string {
  if (host.id === "local") return "This hub";
  if (host.lastSeenAt == null) return "Never seen";
  return `Last seen ${relativeTime(new Date(host.lastSeenAt).toISOString(), now)}`;
}

export function updateProgressText(update: HostUpdateLike | null | undefined): string | null {
  if (!update || update.state === "failed") return null;
  return `${update.state === "installing" ? "Installing" : "Restarting"} ${update.target ?? ""}…`.replace(
    " …",
    "…",
  );
}

/** The label on the Update button, from the update in progress. */
export function updateButtonLabel(update: HostUpdateLike | null | undefined): string {
  if (update?.state === "installing") return "Installing…";
  if (update?.state === "restarting") return "Restarting…";
  if (update?.state === "failed") return "Retry update";
  return "Update";
}

export function isUpdating(update: HostUpdateLike | null | undefined): boolean {
  return update?.state === "installing" || update?.state === "restarting";
}

/** The Update button shows for an admin and a worker that can restart itself. */
export function showUpdateButton(host: HostLike, isAdmin: boolean): boolean {
  return isAdmin && host.canUpdate === true;
}

export interface InterruptedAgent {
  chatId: string;
  worktreeId: string;
  busy: boolean;
}

/** The confirm's list of agents the restart ends. */
export function interruptionLines(agents: readonly InterruptedAgent[]): string[] {
  return agents.map((a) => `${a.worktreeId} (${a.busy ? "working" : "idle"})`);
}
