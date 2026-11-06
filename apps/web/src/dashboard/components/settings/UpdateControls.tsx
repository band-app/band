import { Button, Popover, PopoverContent, PopoverTrigger, Switch } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { HOSTS_LIST_KEY, UPDATE_STATUS_KEY, useUpdateStatus } from "../../hooks/use-update-status";
import { CopyCommand } from "../CopyCommand";

/** Runs the hub's release check now (calls within 30 s share one request) and reads the lists again. */
export function useCheckForUpdates() {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return { check, checking, error };
}

interface Props {
  /** Prefix of the test ids: `<testId>__check`, `__auto`, `__latest`, `__blocked`. */
  testId: string;
  /** Names the controls for assistive tech ("the hub", "build-box"). */
  name: string;
  /** Shows the current version (the hub row). A worker row shows its own version line. */
  version?: string | null;
  /** Shows the latest release and the Check button. Off in the update panel, which has its own. */
  showHeader?: boolean;
  /** The button that starts the update, or null when none applies. */
  updateAction: ReactNode;
  auto: boolean;
  onAutoChange: (on: boolean) => void;
  /** Label next to the switch. */
  autoLabel: string;
  /** The switch is shown but off-limits, with this reason under it. */
  autoDisabledReason?: string | null;
  /** The update cannot run here at all: this replaces the button and the switch. */
  blockedReason?: string | null;
  /** Shown under `blockedReason`, to run by hand. */
  manualCommand?: string | null;
  busy?: boolean;
  children?: ReactNode;
}

/**
 * The update controls of one machine, the same for the hub and each worker: the latest release,
 * "Check for updates", the update button the caller supplies, and the "Update automatically"
 * switch. A machine that cannot update itself shows why instead of the button and the switch.
 */
export function UpdateControls({
  testId,
  name,
  version,
  showHeader = true,
  updateAction,
  auto,
  onAutoChange,
  autoLabel,
  autoDisabledReason,
  blockedReason,
  manualCommand,
  busy,
  children,
}: Props) {
  const status = useUpdateStatus();
  const { check, checking, error } = useCheckForUpdates();
  const checkEnabled = status.data?.checkEnabled !== false;
  const latest = status.data?.latest ?? null;
  return (
    <div className="space-y-2" data-testid={testId}>
      {showHeader ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {version !== undefined ? (
            <span data-testid={`${testId}__version`}>Version: {version ?? "unknown"}</span>
          ) : null}
          <span data-testid={`${testId}__latest`}>Latest release: {latest ?? "not checked"}</span>
          {checkEnabled ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`${testId}__check`}
              aria-label={`Check for updates (${name})`}
              disabled={checking}
              onClick={() => void check()}
            >
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          ) : null}
          {error ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`Update check failed (${name})`}
                  data-testid={`${testId}__check-error-icon`}
                  className="shrink-0 rounded-sm text-destructive"
                >
                  <CircleAlert className="size-3.5" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 text-xs">
                <p
                  role="alert"
                  data-testid={`${testId}__check-error`}
                  className="break-words text-destructive"
                >
                  {error}
                </p>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      ) : null}
      {blockedReason ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p data-testid={`${testId}__blocked`}>{blockedReason}</p>
          {manualCommand ? (
            <CopyCommand
              command={manualCommand}
              testId={`${testId}__manual`}
              label={`Copy the update command for ${name}`}
            />
          ) : null}
        </div>
      ) : (
        <>
          {updateAction ? <div className="flex items-center gap-2">{updateAction}</div> : null}
          <div className="flex items-center gap-2">
            <Switch
              aria-label={`Update ${name} automatically`}
              data-testid={`${testId}__auto`}
              checked={auto}
              disabled={busy || !!autoDisabledReason}
              onCheckedChange={onAutoChange}
            />
            <span className="text-xs text-muted-foreground">{autoLabel}</span>
          </div>
          {autoDisabledReason ? (
            <p className="text-xs text-muted-foreground" data-testid={`${testId}__auto-note`}>
              {autoDisabledReason}
            </p>
          ) : null}
        </>
      )}
      {children}
    </div>
  );
}
