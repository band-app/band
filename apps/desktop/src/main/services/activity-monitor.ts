/**
 * Drives the web server's `services.setActivity` mutation based on local
 * window focus + AC/battery state.
 *
 * The branch-status poller (apps/web/src/lib/branch-status-poller.ts) keeps
 * shelling out to git/gh on a 5 s tick by default. That's wasted energy when
 * the window is unfocused or the laptop is on battery, so the desktop shell
 * notifies the server to widen the interval:
 *
 *   focused && !onBattery  → "active"      (5 s git / 30 s CI — original)
 *   focused &&  onBattery  → "idle"        (30 s git / 3 min CI)
 *  !focused && !onBattery  → "idle"        (30 s git / 3 min CI)
 *  !focused &&  onBattery  → "background"  (60 s git / 10 min CI)
 *
 * Failures are logged but never thrown — this is a best-effort optimization
 * and the server defaults to "active" if nothing ever calls it.
 */

import { type BrowserWindow, powerMonitor } from "electron";
import { createLogger } from "./log.js";
import { getConfiguredPort, tryGetToken } from "./settings.js";

const log = createLogger("activity-monitor");

type ActivityLevel = "active" | "idle" | "background";

const DEBOUNCE_MS = 250;
const REQUEST_TIMEOUT_MS = 2_000;

export interface ActivityMonitorOptions {
  mainWindow: BrowserWindow;
  /** Override the configured port (defaults to settings.json / 3456). */
  port?: number;
}

export interface ActivityMonitorHandle {
  /** Remove all listeners. The window's listeners auto-release on close, but
   *  powerMonitor's are global and need explicit teardown. */
  stop: () => void;
}

function computeActivity(focused: boolean, onBattery: boolean): ActivityLevel {
  if (focused && !onBattery) return "active";
  if (!focused && onBattery) return "background";
  return "idle";
}

async function postActivity(port: number, activity: ActivityLevel): Promise<void> {
  const token = tryGetToken();
  if (!token) {
    // Server may not have written settings.json yet (during startup). Skip —
    // the next state change will retry.
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/trpc/services.setActivity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `band_token=${token}`,
      },
      body: JSON.stringify({ activity }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn({ activity, status: res.status }, "setActivity HTTP error");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ activity, err: msg }, "setActivity failed");
  }
}

/**
 * Wire focus + powerMonitor listeners and POST every transition to the web
 * server. Returns a teardown handle.
 */
export function startActivityMonitor(opts: ActivityMonitorOptions): ActivityMonitorHandle {
  const port = opts.port ?? getConfiguredPort();

  let focused = opts.mainWindow.isFocused();
  let onBattery = powerMonitor.isOnBatteryPower();
  let lastSent: ActivityLevel | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    debounceTimer = null;
    const next = computeActivity(focused, onBattery);
    if (next === lastSent) return;
    lastSent = next;
    void postActivity(port, next);
  };

  /** Coalesce rapid focus/blur transitions (e.g. cmd-tab through windows). */
  const schedule = (): void => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  };

  const onFocus = () => {
    focused = true;
    schedule();
  };
  const onBlur = () => {
    focused = false;
    schedule();
  };
  const onAc = () => {
    onBattery = false;
    schedule();
  };
  const onBatt = () => {
    onBattery = true;
    schedule();
  };

  opts.mainWindow.on("focus", onFocus);
  opts.mainWindow.on("blur", onBlur);
  powerMonitor.on("on-ac", onAc);
  powerMonitor.on("on-battery", onBatt);

  // Send initial state so the server isn't stuck at "active" if Band launched
  // into the background or on battery.
  schedule();

  return {
    stop: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      opts.mainWindow.off("focus", onFocus);
      opts.mainWindow.off("blur", onBlur);
      powerMonitor.off("on-ac", onAc);
      powerMonitor.off("on-battery", onBatt);
    },
  };
}
