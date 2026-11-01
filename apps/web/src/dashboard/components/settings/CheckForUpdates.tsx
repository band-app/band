import { Button, Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { HOSTS_LIST_KEY, UPDATE_STATUS_KEY, useUpdateStatus } from "../../hooks/use-update-status";
import { useIsAdmin } from "./DevicesSettings";

/**
 * "Check for updates" on Settings > Workers. The hub asks GitHub for the latest release at once
 * (calls within 30 s share one request), then the worker list and the update status are read again
 * so the Update buttons and the sidebar badge appear without a reload. Hidden for a non-admin
 * token and when the hub's check is turned off.
 */
export function CheckForUpdates() {
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const status = useUpdateStatus();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin || !status.data || !status.data.checkEnabled) return null;
  const checkedAt = status.data.checkedAt;

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await trpc.workers.checkForUpdates.mutate();
      setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_KEY }),
      queryClient.invalidateQueries({ queryKey: HOSTS_LIST_KEY }),
    ]);
    setChecking(false);
  };

  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="settings__check-updates"
        disabled={checking}
        onClick={() => void check()}
      >
        {checking ? "Checking…" : "Check for updates"}
      </Button>
      <span data-testid="settings__check-updates-last">
        {checkedAt ? `Last checked ${new Date(checkedAt).toLocaleString()}` : "Not checked yet"}
      </span>
      {error ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Update check failed"
              data-testid="settings__check-updates-error-icon"
              className="shrink-0 rounded-sm text-destructive"
            >
              <CircleAlert className="size-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 text-xs">
            <p
              role="alert"
              data-testid="settings__check-updates-error"
              className="break-words text-destructive"
            >
              {error}
            </p>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
