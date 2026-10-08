import { useCallback, useEffect, useState } from "react";
import { invoke } from "./desktop-ipc";
import { isDesktop } from "./is-desktop";

/** Mirrors `ThisComputerStatus` in `apps/desktop/src/shared/types.ts`. */
export interface ThisComputerStatus {
  supported: boolean;
  remoteHub: boolean;
  installed: boolean;
  bundled: boolean;
  running: boolean;
  forThisHub: boolean;
  hostId: string | null;
  name: string | null;
  roots: string[];
  hostStatus: string | null;
  version: string;
  defaultName: string;
  promptPending: boolean;
}

export type ThisComputerResult = { ok: true; note?: string } | { ok: false; error: string };

/** Asks the app for the folder picker's choice. Null when the person cancels. */
export function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

/**
 * The state of this computer as a worker of the hub the desktop app is connected to, and the
 * actions on it. Outside the desktop app there is nothing to read, so `status` stays null.
 * `run` reports the first failure through `error` and refreshes the status either way.
 */
export function useThisComputerWorker() {
  const [status, setStatus] = useState<ThisComputerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isDesktop) return;
    try {
      setStatus(await invoke<ThisComputerStatus>("worker_status"));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (channel: string, args?: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const result = await invoke<ThisComputerResult>(channel, args);
        if (!result.ok) {
          setError(result.error);
          return false;
        }
        if (result.note) setNote(result.note);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  return { status, busy, error, note, refresh, run };
}
