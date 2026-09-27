import { useSyncExternalStore } from "react";

/** The viewport width at which the dashboard switches to its desktop layout. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribe(cb: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot() {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
