import { usePowerState } from "./power-state";

/** How much slower a poll runs on battery, unless the call site asks for another factor. */
const DEFAULT_BATTERY_FACTOR = 3;

/**
 * Turns a poll interval into the one to use now: paused (`false`) while the window is blurred or
 * hidden, `batteryFactor` times slower on battery, `baseMs` otherwise. A paused query refetches when
 * the window gets focus again (react-query's `refetchOnWindowFocus`), and `false` passes through.
 */
export function pollIntervalFor(
  baseMs: number | false,
  state: { onBattery: boolean; focused: boolean },
  batteryFactor = DEFAULT_BATTERY_FACTOR,
): number | false {
  if (baseMs === false) return false;
  if (!state.focused) return false;
  return state.onBattery ? baseMs * batteryFactor : baseMs;
}

export function usePollInterval(baseMs: number | false, batteryFactor?: number): number | false {
  return pollIntervalFor(baseMs, usePowerState(), batteryFactor);
}
