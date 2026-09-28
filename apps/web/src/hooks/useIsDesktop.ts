import { useMediaQuery } from "./useMediaQuery";

/** The viewport width at which the dashboard switches to its desktop layout. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
