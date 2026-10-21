import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { HOSTS_LIST_KEY, type HostView } from "../hooks/use-update-status";

interface Props {
  host: HostView;
}

/**
 * "Update" for one worker, with the confirm dialog that lists the agents the restart will end.
 * Nothing is sent until Confirm. The hub installs the release on the worker and the worker
 * restarts through its service manager; the row follows the result (installing, restarting, or
 * the error with the worker still on its old version).
 */
export function WorkerUpdateButton({ host }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interruptions = useQuery({
    queryKey: ["hosts.interruptions", host.id],
    queryFn: () => trpc.workers.interruptions.query({ hostId: host.id }),
    enabled: open,
    gcTime: 0,
  });

  const progress = host.update?.state;
  const working = progress === "installing" || progress === "restarting";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.workers.update.mutate({ hostId: host.id });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: HOSTS_LIST_KEY });
    }
  };

  const agents = interruptions.data?.agents ?? [];

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Update ${host.name}`}
        data-testid="update-worker__button"
        disabled={working}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {progress === "installing"
          ? "Installing…"
          : progress === "restarting"
            ? "Restarting…"
            : progress === "failed"
              ? "Retry update"
              : "Update"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="sm:max-w-[460px]" data-testid="update-worker__dialog">
          <DialogHeader>
            <DialogTitle>
              Update {host.name} to {host.updateTarget}?
            </DialogTitle>
            <DialogDescription>
              The worker installs the new version and restarts. Restarting ends every agent running
              on this worker, and a turn in progress is lost.
            </DialogDescription>
          </DialogHeader>
          <div
            className="text-sm"
            data-testid="update-worker__agents"
            data-state={
              interruptions.isLoading
                ? "loading"
                : interruptions.isError
                  ? "error"
                  : agents.length === 0
                    ? "none"
                    : "some"
            }
          >
            {interruptions.isLoading ? (
              <span className="text-muted-foreground">Checking running agents…</span>
            ) : interruptions.isError ? (
              <span className="text-destructive" data-testid="update-worker__agents-error">
                Could not check which agents are running on this worker.
              </span>
            ) : agents.length === 0 ? (
              <span className="text-muted-foreground">No agents are running on this worker.</span>
            ) : (
              <>
                <div className="mb-1 font-medium">
                  {agents.length === 1 ? "1 agent" : `${agents.length} agents`} will be interrupted:
                </div>
                <ul className="list-disc pl-5">
                  {agents.map((a) => (
                    <li key={a.chatId} data-testid="update-worker__agent">
                      {a.worktreeId} ({a.busy ? "working" : "idle"})
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {error ? (
            <p role="alert" data-testid="update-worker__error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="update-worker__confirm"
              onClick={() => void confirm()}
              disabled={busy || interruptions.isLoading || interruptions.isError}
            >
              {busy ? "Installing…" : "Update and restart"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
