import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { trpc } from "../../lib/trpc-client";
import { useHostsList, useUpdateStatus } from "../hooks/use-update-status";
import { CopyCommand } from "./CopyCommand";
import { useIsAdmin } from "./settings/DevicesSettings";
import { WorkerUpdateButton } from "./WorkerUpdateButton";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * What a newer Band release means for this setup: the hub's version, each worker's version and
 * the version to move to, an Update button per worker that can restart itself, and the command
 * for the hub. Workers go first and the hub last, so a hub is never older than its workers.
 */
export function UpdatePanelDialog({ open, onOpenChange }: Props) {
  const status = useUpdateStatus();
  const hosts = useHostsList(open);
  const isAdmin = useIsAdmin();
  const workers = (hosts.data ?? []).filter((h) => h.id !== "local");
  const info = status.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]" data-testid="update-panel">
        <DialogHeader>
          <DialogTitle>Update Band</DialogTitle>
          <DialogDescription data-testid="update-panel__order">
            Update the workers first and the hub last, so the hub is never older than its workers.
          </DialogDescription>
        </DialogHeader>
        {info ? (
          <ul className="space-y-3">
            {workers.map((host) => (
              <li
                key={host.id}
                data-testid="update-panel__host"
                data-host-id={host.id}
                className="rounded-md border border-border p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{host.name}</div>
                    <div className="text-xs text-muted-foreground">
                      <span data-testid="update-panel__host-version">
                        {host.workerVersion ?? "unknown version"}
                      </span>
                      {host.updateTarget ? (
                        <>
                          {" → "}
                          <span data-testid="update-panel__host-target">{host.updateTarget}</span>
                        </>
                      ) : (
                        <span data-testid="update-panel__host-current"> · up to date</span>
                      )}
                      {" · "}
                      {host.status}
                    </div>
                  </div>
                  {host.canUpdate && isAdmin ? <WorkerUpdateButton host={host} /> : null}
                </div>
                {host.update?.state === "failed" ? (
                  <HostUpdateError hostId={host.id} message={host.update.error} />
                ) : null}
                {host.updateTarget && !(host.canUpdate && isAdmin) && host.manualCommand ? (
                  <div className="mt-2 space-y-1">
                    <div className="text-xs text-muted-foreground">
                      {host.canUpdate
                        ? "Ask an admin to update it, or run on the worker:"
                        : "Run on the worker, then restart it:"}
                    </div>
                    <CopyCommand
                      command={host.manualCommand}
                      testId="update-panel__host-manual"
                      label={`Copy the update command for ${host.name}`}
                    />
                  </div>
                ) : null}
              </li>
            ))}
            <li
              data-testid="update-panel__hub"
              className="rounded-md border border-border p-3 text-sm"
            >
              <div className="font-medium">Hub</div>
              <div className="mb-2 text-xs text-muted-foreground">
                <span data-testid="update-panel__hub-version">{info.hubVersion}</span>
                {info.latest ? (
                  <>
                    {" → "}
                    <span data-testid="update-panel__hub-target">{info.latest}</span>
                  </>
                ) : null}
              </div>
              <CopyCommand
                command={info.hubCommand}
                testId="update-panel__hub"
                label="Copy the hub update command"
              />
            </li>
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function HostUpdateError({ hostId, message }: { hostId: string; message: string | null }) {
  return (
    <div className="mt-2 flex items-start justify-between gap-2 text-xs text-destructive">
      <span role="alert" data-testid="update-panel__host-error">
        {message}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void trpc.hosts.dismissUpdate.mutate({ hostId })}
      >
        Dismiss
      </Button>
    </div>
  );
}
