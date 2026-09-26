import { useCallback, useEffect, useState } from "react";
import type { UpdateStatus } from "../adapter";
import { useAdapter } from "../context";

/** How long "You're on the latest version" stays up before it dismisses itself. */
const UP_TO_DATE_DISMISS_MS = 4000;

/**
 * State for the update toast. The desktop main process
 * (`apps/desktop/src/main/updater.ts`) owns the update flow; this hook reads
 * its status once on mount (the startup check may have finished before the
 * renderer subscribed) and follows `updater-status-changed` after that.
 *
 * `status` is `null` when the toast should be hidden: outside the desktop
 * shell (the web adapter has no updater methods), when idle, and for the
 * checking / up-to-date / error steps of a background check, which stay
 * silent unless they find an update.
 */
export function useAppUpdate() {
  const adapter = useAdapter();
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    if (!adapter.getUpdateStatus || !adapter.subscribeUpdateStatus) return;
    let cancelled = false;
    let received = false;

    const unsubscribe = adapter.subscribeUpdateStatus((next) => {
      received = true;
      setStatus(next);
    });
    adapter
      .getUpdateStatus()
      .then((initial) => {
        // A broadcast that arrived first is newer than this snapshot.
        if (!cancelled && !received) setStatus(initial);
      })
      .catch(() => {
        // The main process logs updater failures; the toast stays hidden.
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [adapter]);

  const dismiss = useCallback(() => {
    // Hide right away; main confirms with an `idle` broadcast.
    setStatus({ state: "idle" });
    adapter.dismissUpdate?.().catch(ignore);
  }, [adapter]);

  useEffect(() => {
    if (status.state !== "up-to-date") return;
    const timer = setTimeout(dismiss, UP_TO_DATE_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [status, dismiss]);

  const retry = useCallback(() => {
    if (status.state !== "error") return;
    if (status.phase === "download") adapter.downloadUpdate?.().catch(ignore);
    else adapter.checkForUpdates?.().catch(ignore);
  }, [adapter, status]);

  return {
    status: isVisible(status) ? status : null,
    download: useCallback(() => adapter.downloadUpdate?.().catch(ignore), [adapter]),
    restart: useCallback(() => adapter.restartToUpdate?.().catch(ignore), [adapter]),
    retry,
    dismiss,
  };
}

/** The IPC call only fails once the window is closing; the main process logs
 *  updater failures and reports them through the status. */
function ignore(): void {}

function isVisible(status: UpdateStatus): boolean {
  switch (status.state) {
    case "idle":
      return false;
    case "checking":
    case "up-to-date":
    case "error":
      return status.userInitiated;
    case "available":
    case "downloading":
    case "downloaded":
      return true;
  }
}
