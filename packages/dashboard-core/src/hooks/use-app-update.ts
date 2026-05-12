import { useEffect, useState } from "react";
import { useAdapter } from "../context";

/**
 * Banner state for the desktop auto-updater. Driven by:
 *   - Main process (`apps/desktop/src/main/updater.ts`) running a 10s startup
 *     check + a 2h periodic check.
 *   - The renderer subscribing to `updater-status-changed` and, on mount,
 *     polling `updater_status` once to catch the race where the renderer
 *     mounted after the startup check already completed.
 *
 * Outside the desktop shell (plain browser tab, or web adapter that doesn't
 * implement `getUpdateStatus`), the hook stays permanently at `"none"` so the
 * banner never appears.
 */
export type AppUpdateState =
  | { status: "none" }
  | { status: "available"; version: string }
  | { status: "installing" }
  | { status: "error"; message: string };

export function useAppUpdate() {
  const adapter = useAdapter();
  const [state, setState] = useState<AppUpdateState>({ status: "none" });

  useEffect(() => {
    // Web adapter doesn't implement these — the banner stays hidden.
    if (!adapter.getUpdateStatus || !adapter.subscribeUpdateStatus) return;

    let cancelled = false;

    // Seed initial state. If the main-process startup check fired before
    // this component mounted, the subscription below would miss that
    // broadcast — the one-shot query catches it.
    adapter
      .getUpdateStatus()
      .then((pending) => {
        if (cancelled) return;
        if (pending) {
          setState({ status: "available", version: pending.version });
        }
      })
      .catch(() => {
        // Swallow — the hook's job is the banner, not error surfacing.
        // The main process logs failures via `dashLog`.
      });

    const unsubscribe = adapter.subscribeUpdateStatus((pending) => {
      // Don't clobber an in-flight install with a stale broadcast (the
      // periodic check could fire after the user clicked Install but
      // before quitAndInstall takes the process down).
      setState((prev) => {
        if (prev.status === "installing") return prev;
        return pending ? { status: "available", version: pending.version } : { status: "none" };
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [adapter]);

  const install = async () => {
    if (!adapter.installUpdate) return;
    // Optimistic state flip BEFORE awaiting — the OS quits the process on
    // success, so the awaited promise typically never resolves in
    // production. The banner needs to swap to the "Installing…" state
    // before that happens so the user has visible feedback.
    setState({ status: "installing" });
    try {
      await adapter.installUpdate();
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { state, install };
}
