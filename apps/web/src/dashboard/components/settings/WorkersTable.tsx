import { cn } from "@band-app/ui";
import { ChevronRight } from "lucide-react";
import type { HostView } from "../../hooks/use-update-status";
import { AgentIcon } from "../agent-icons";
import { ErrorPopover } from "./ErrorPopover";
import { blockedReasonFor } from "./WorkerUpdatesSection";
import { type HostItem, osOf, STATUS_PILL, TRUST_HINT, TRUST_LABEL } from "./worker-format";

interface Props {
  hosts: HostItem[];
  /** The worker that is this Mac (desktop app), whose row carries the "This computer" badge. */
  thisComputerId: string | null;
  /** This Mac's worker is the one bundled in the app, so it updates with the app. */
  thisComputerBundled: boolean;
  onOpen: (hostId: string) => void;
  onDismissUpdate: (hostId: string) => void;
}

/** What the version cell shows next to the version: the Update pill, a note or nothing. */
function UpdateCell({
  host,
  bundled,
  onOpen,
}: {
  host: HostView;
  bundled: boolean;
  onOpen: () => void;
}) {
  if (host.update && host.update.state !== "failed") {
    return (
      <span className="text-xs text-muted-foreground" data-testid="settings__host-update-progress">
        {host.update.state === "installing" ? "Installing" : "Restarting"} {host.update.target}…
      </span>
    );
  }
  const behind = host.versionState === "behind" || host.versionState === "refused";
  if (behind && bundled) {
    return (
      <span
        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
        data-testid="settings__host-update-bundled"
      >
        Updates with Band app
      </span>
    );
  }
  if (behind && host.updateTarget) {
    const actionable = host.canUpdate && !blockedReasonFor(host);
    return (
      <button
        type="button"
        data-testid="settings__host-update-pill"
        data-actionable={actionable}
        aria-label={`Update ${host.name} to ${host.updateTarget}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="rounded-full bg-warning-bg px-2 py-0.5 text-xs text-warning"
      >
        Update to {host.updateTarget}
      </button>
    );
  }
  if (host.versionState === "ahead") {
    return (
      <span
        data-testid="settings__host-version-state"
        data-state="ahead"
        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      >
        ahead of the hub
      </span>
    );
  }
  if (host.versionState === "unknown") {
    return (
      <span
        data-testid="settings__host-version-state"
        data-state="unknown"
        className="rounded-full bg-warning-bg px-2 py-0.5 text-xs text-warning"
      >
        version unknown
      </span>
    );
  }
  return null;
}

/**
 * The Workers table: one row per worker, all the same height. A row shows the name and OS, the
 * status, the version with its Update pill, trust and the agents; a click opens the drawer. On a
 * phone the cells wrap into a stacked row. Update failures show as an icon with a popover.
 */
export function WorkersTable({
  hosts,
  thisComputerId,
  thisComputerBundled,
  onOpen,
  onDismissUpdate,
}: Props) {
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="settings__hosts-table"
    >
      {hosts.map((host) => {
        const isThis = host.id === thisComputerId;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the name button inside is the keyboard path to the same drawer
          <li
            key={host.id}
            data-testid="settings__host"
            data-status={host.status}
            data-host-id={host.id}
            className="group flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm hover:bg-muted/40 sm:min-h-14 sm:flex-nowrap"
            onClick={(e) => {
              // A popover renders in a portal but still bubbles through this row in React.
              if (e.currentTarget.contains(e.target as Node)) onOpen(host.id);
            }}
          >
            <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="settings__host-name"
                  aria-label={`Open ${host.name}`}
                  className="min-w-0 truncate rounded-sm text-left font-medium"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(host.id);
                  }}
                >
                  {host.name}
                </button>
                {isThis ? (
                  <span
                    data-testid="this-computer__state"
                    data-status={host.status}
                    className="shrink-0 rounded-full border border-border px-1.5 text-xs text-muted-foreground"
                  >
                    This computer
                  </span>
                ) : null}
              </div>
              <div
                className="truncate text-xs text-muted-foreground"
                data-testid="settings__host-os-line"
              >
                {osOf(host)}
              </div>
            </div>
            <span
              data-testid="settings__host-status"
              className={cn(
                "shrink-0 rounded-full px-2.5 py-0.5 text-xs",
                STATUS_PILL[host.status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {host.status}
            </span>
            <div className="flex min-w-0 shrink-0 items-center gap-1.5 sm:w-52">
              <span
                data-testid="settings__host-version"
                data-version={host.workerVersion ?? "unknown"}
                className="text-xs text-muted-foreground"
              >
                {host.workerVersion ?? "unknown"}
              </span>
              <UpdateCell
                host={host}
                bundled={isThis && thisComputerBundled}
                onOpen={() => onOpen(host.id)}
              />
              {host.updateRequired ? (
                <ErrorPopover
                  label="Update required"
                  testId="settings__host-update-required"
                  message={host.updateRequired}
                />
              ) : null}
              {host.update?.state === "failed" ? (
                <ErrorPopover
                  label="Update failed"
                  testId="settings__host-update-error"
                  message={host.update.error}
                  onDismiss={() => onDismissUpdate(host.id)}
                />
              ) : null}
            </div>
            {/* A fixed-width cell, empty for the built-in worker, keeps the columns aligned. */}
            <div
              className={cn(
                "shrink-0 sm:flex sm:w-24 sm:justify-end",
                host.id === "local" && "hidden",
              )}
            >
              {host.id !== "local" ? (
                <span
                  data-testid="settings__host-trust"
                  title={TRUST_HINT[host.trust]}
                  className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {TRUST_LABEL[host.trust]}
                </span>
              ) : null}
            </div>
            <div
              className="flex shrink-0 items-center gap-1.5"
              data-testid="settings__host-agent-icons"
            >
              {host.agentCommandStates.map((a) => (
                <span
                  key={a.agentId}
                  className="relative"
                  title={a.found === false ? `${a.label} not found` : a.label}
                >
                  <AgentIcon type={a.type} className="size-4" />
                  {a.found === false ? (
                    <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive" />
                  ) : null}
                </span>
              ))}
            </div>
            <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
          </li>
        );
      })}
    </ul>
  );
}
