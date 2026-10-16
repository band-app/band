import { Button } from "@band-app/ui";
import { trpc } from "../../../lib/trpc-client";
import type { HostView } from "../../hooks/use-update-status";
import { CopyCommand } from "../CopyCommand";
import { WorkerUpdateButton } from "../WorkerUpdateButton";

const STATE_LABEL: Record<HostView["versionState"], string | null> = {
  current: null,
  ahead: "ahead of the hub",
  behind: "behind the hub",
  unknown: "version unknown, update recommended",
  refused: "update required",
};

/**
 * A host's Band version on the Hosts screen: what it runs, whether it is behind the hub, the
 * Update button (admin, and only for a worker that can restart itself) or the command to run by
 * hand, and the result of an update in progress.
 */
export function HostVersionLine({ host, isAdmin }: { host: HostView; isAdmin: boolean }) {
  const label = STATE_LABEL[host.versionState];
  const showButton = host.canUpdate && isAdmin;
  return (
    <div
      className="space-y-1 text-xs text-muted-foreground"
      data-testid="settings__host-version-block"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="settings__host-version" data-version={host.workerVersion ?? "unknown"}>
          Version: {host.workerVersion ?? "unknown"}
        </span>
        {label ? (
          <span
            data-testid="settings__host-version-state"
            data-state={host.versionState}
            className="rounded bg-warning-bg px-1.5 py-0.5 text-warning"
          >
            {label}
          </span>
        ) : null}
        {showButton ? <WorkerUpdateButton host={host} /> : null}
      </div>
      {host.updateRequired ? (
        <div data-testid="settings__host-update-required" className="text-destructive">
          {host.updateRequired}
        </div>
      ) : null}
      {host.update?.state === "failed" ? (
        <div className="flex items-start justify-between gap-2 text-destructive">
          <span role="alert" data-testid="settings__host-update-error">
            {host.update.error}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void trpc.hosts.dismissUpdate.mutate({ hostId: host.id })}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {host.update && host.update.state !== "failed" ? (
        <div data-testid="settings__host-update-progress">
          {host.update.state === "installing" ? "Installing" : "Restarting"} {host.update.target}…
        </div>
      ) : null}
      {host.updateTarget && !showButton && host.manualCommand ? (
        <div className="space-y-1">
          <div>Run on the worker, then restart it:</div>
          <CopyCommand
            command={host.manualCommand}
            testId="settings__host-manual"
            label={`Copy the update command for ${host.name}`}
          />
        </div>
      ) : null}
    </div>
  );
}
