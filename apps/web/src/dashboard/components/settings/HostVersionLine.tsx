import { Button, Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { trpc } from "../../../lib/trpc-client";
import { HOSTS_LIST_KEY, type HostView } from "../../hooks/use-update-status";
import { CopyCommand } from "../CopyCommand";
import { WorkerUpdateButton } from "../WorkerUpdateButton";
import { UpdateControls } from "./UpdateControls";

const STATE_LABEL: Record<HostView["versionState"], string | null> = {
  current: null,
  ahead: "ahead of the hub",
  behind: "behind the hub",
  unknown: "version unknown, update recommended",
  refused: "update required",
};

/** An error as a destructive icon. The message and the optional Dismiss action live in its popover. */
function ErrorPopover({
  label,
  testId,
  message,
  onDismiss,
}: {
  label: string;
  testId: string;
  message: string | null | undefined;
  onDismiss?: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={`${testId}-icon`}
          className="shrink-0 rounded-sm text-destructive"
        >
          <CircleAlert className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 text-xs">
        <p role="alert" data-testid={testId} className="break-words text-destructive">
          {message}
        </p>
        {onDismiss ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="settings__host-update-dismiss"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Why a worker takes no automatic update, or null when it can. The row shows this instead of the
 * Update button and the switch.
 */
function blockedReasonFor(host: HostView): string | null {
  if (host.updateBlockedReason)
    return `This worker cannot update itself: ${host.updateBlockedReason}`;
  if (!host.serviceManager) {
    return "This worker does not run under launchd or a systemd user unit, so the hub cannot restart it.";
  }
  return null;
}

/**
 * A host's Band version on the Hosts screen: what it runs, whether it is behind the hub, the
 * same update controls as the hub (latest release, Check for updates, Update, Update
 * automatically) for an admin, the command to run by hand for a worker that cannot restart itself,
 * and the result of an update in progress.
 */
export function HostVersionLine({ host, isAdmin }: { host: HostView; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const label = STATE_LABEL[host.versionState];
  const showButton = host.canUpdate && isAdmin;
  const blocked = blockedReasonFor(host);
  const showControls = isAdmin && host.id !== "local";
  const autoDisabledReason =
    host.versionState === "ahead"
      ? "Newer than the hub, so it is not updated until the hub catches up."
      : host.versionState === "unknown"
        ? "The version is unknown, so it is not updated automatically."
        : null;
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
            onDismiss={() =>
              void trpc.workers.dismissUpdate
                .mutate({ hostId: host.id })
                .then(() => queryClient.invalidateQueries({ queryKey: HOSTS_LIST_KEY }))
            }
          />
        ) : null}
      </div>
      {host.update && host.update.state !== "failed" ? (
        <div data-testid="settings__host-update-progress">
          {host.update.state === "installing" ? "Installing" : "Restarting"} {host.update.target}…
        </div>
      ) : null}
      {showControls ? (
        <UpdateControls
          testId="worker-update"
          name={host.name}
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
            <p className="text-xs text-muted-foreground" data-testid="worker-update__deferred">
              Waiting for running agents since{" "}
              {new Date(host.autoUpdateDeferredSince).toLocaleString()}.
            </p>
          ) : null}
        </UpdateControls>
      ) : host.updateTarget && host.manualCommand ? (
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
