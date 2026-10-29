import { Button } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { UPDATE_STATUS_KEY, useUpdateStatus } from "../hooks/use-update-status";

/** Progress is read from `updateStatus`, so poll while the run is going. */
const POLL_MS = 1500;

/**
 * "Update all workers": starts the hub's one-after-the-other run and lists the result per worker.
 * A worker with running agents is skipped until the admin confirms interrupting them.
 */
export function UpdateAllWorkers({
  behindCount,
  canUpdateHub = false,
}: {
  behindCount: number;
  canUpdateHub?: boolean;
}) {
  const queryClient = useQueryClient();
  const status = useUpdateStatus();
  const [error, setError] = useState<string | null>(null);
  const all = status.data?.updateAll;
  const running = all?.running === true;
  const skipped = (all?.results ?? []).some((r) => r.state === "skipped");

  const start = async (confirmInterruptions: boolean, includeHub = false) => {
    setError(null);
    try {
      await trpc.workers.updateAll.mutate({ confirmInterruptions, includeHub });
      const timer = setInterval(() => {
        void queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_KEY }).then(() => {
          const now = queryClient.getQueryData<{ updateAll: { running: boolean } }>(
            UPDATE_STATUS_KEY,
          );
          if (!now?.updateAll.running) clearInterval(timer);
        });
      }, POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_KEY });
  };

  if (behindCount === 0 && !all?.results.length) return null;
  return (
    <div className="space-y-2" data-testid="update-all">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="update-all__button"
          disabled={running || behindCount === 0}
          onClick={() => void start(false)}
        >
          {running ? "Updating workers…" : "Update all workers"}
        </Button>
        {canUpdateHub ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="update-all__with-hub"
            disabled={running}
            onClick={() => void start(false, true)}
          >
            Update workers, then the hub
          </Button>
        ) : null}
        {skipped && !running ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="update-all__confirm"
            onClick={() => void start(true)}
          >
            Update the skipped workers anyway
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" data-testid="update-all__error" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="space-y-1 text-xs">
        {(all?.results ?? []).map((r) => (
          <li
            key={r.hostId}
            data-testid="update-all__result"
            data-host-id={r.hostId}
            data-state={r.state}
            className="text-muted-foreground"
          >
            {r.name}: {r.state}
            {r.message ? ` (${r.message})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
