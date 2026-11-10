import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../../lib/trpc-client";
import { HOSTS_LIST_KEY, type HostView } from "../../hooks/use-update-status";
import { CopyCommand } from "../CopyCommand";
import { WorkerUpdateButton } from "../WorkerUpdateButton";
import { UpdateControls } from "./UpdateControls";

/**
 * Why a worker takes no automatic update, or null when it can. The drawer shows this instead of
 * the Update button and the switch.
 */
export function blockedReasonFor(host: HostView): string | null {
  if (host.updateBlockedReason)
    return `This worker cannot update itself: ${host.updateBlockedReason}`;
  if (!host.serviceManager) {
    return "This worker does not run under launchd or a systemd user unit, so the hub cannot restart it.";
  }
  return null;
}

/**
 * The Updates section of a worker's drawer: its version, the version it is heading to, Update,
 * the auto-update switch and, for a worker that cannot restart itself, why and the command to run
 * by hand. Controls are admin only and never shown for the built-in worker.
 */
export function WorkerUpdatesSection({
  host,
  isAdmin,
  bundled = false,
}: {
  host: HostView;
  isAdmin: boolean;
  /** This Mac's worker is bundled in the app and updates with it. */
  bundled?: boolean;
}) {
  const queryClient = useQueryClient();
  const showButton = host.canUpdate && isAdmin && !bundled;
  const blocked = bundled ? null : blockedReasonFor(host);
  const showControls = isAdmin && host.id !== "local";
  const autoDisabledReason =
    host.versionState === "ahead"
      ? "Newer than the hub, so it is not updated until the hub catches up."
      : host.versionState === "unknown"
        ? "The version is unknown, so it is not updated automatically."
        : null;
  return (
    <div className="space-y-2 text-xs" data-testid="settings__host-version-block">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
        <span data-testid="settings__host-drawer-version" data-version={host.workerVersion ?? ""}>
          Version: {host.workerVersion ?? "unknown"}
        </span>
        {host.updateTarget ? (
          <span data-testid="settings__host-drawer-target">Target: {host.updateTarget}</span>
        ) : null}
      </div>
      {host.update && host.update.state !== "failed" ? (
        <div className="text-muted-foreground" data-testid="settings__host-update-progress">
          {host.update.state === "installing" ? "Installing" : "Restarting"} {host.update.target}…
        </div>
      ) : null}
      {bundled ? (
        <div className="text-muted-foreground" data-testid="settings__host-drawer-bundled">
          Updates with Band app
        </div>
      ) : showControls ? (
        <UpdateControls
          testId="worker-update"
          name={host.name}
          showHeader={false}
          updateAction={showButton ? <WorkerUpdateButton host={host} /> : null}
          auto={host.autoUpdate}
          autoLabel="Update automatically when idle"
          autoDisabledReason={autoDisabledReason}
          blockedReason={blocked}
          manualCommand={host.updateTarget ? host.manualCommand : null}
          onAutoChange={(on) =>
            void trpc.workers.setAutoUpdate
              .mutate({ hostId: host.id, auto: on })
              .then(() => queryClient.invalidateQueries({ queryKey: HOSTS_LIST_KEY }))
          }
        >
          {host.autoUpdate && host.autoUpdateDeferredSince ? (
            <p className="text-muted-foreground" data-testid="worker-update__deferred">
              Waiting for running agents since{" "}
              {new Date(host.autoUpdateDeferredSince).toLocaleString()}.
            </p>
          ) : null}
        </UpdateControls>
      ) : host.updateTarget && host.manualCommand ? (
        <div className="space-y-1 text-muted-foreground">
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
