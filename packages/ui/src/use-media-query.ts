import { useCallback, useSyncExternalStore } from "react";

/** The viewport width at which the dashboard switches to its desktop layout. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** Whether `query` matches, re-rendering when it starts or stops matching. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
