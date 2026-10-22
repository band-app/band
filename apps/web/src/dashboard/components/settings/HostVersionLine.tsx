import { Button, Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { trpc } from "../../../lib/trpc-client";
import { HOSTS_LIST_KEY, type HostView } from "../../hooks/use-update-status";
import { CopyCommand } from "../CopyCommand";
import { WorkerUpdateButton } from "../WorkerUpdateButton";

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
 * A host's Band version on the Hosts screen: what it runs, whether it is behind the hub, the
 * Update button (admin, and only for a worker that can restart itself) or the command to run by
 * hand, and the result of an update in progress.
 */
export function HostVersionLine({ host, isAdmin }: { host: HostView; isAdmin: boolean }) {
  const queryClient = useQueryClient();
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
        {showButton ? <WorkerUpdateButton host={host} /> : null}
      </div>
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
