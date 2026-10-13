import { DESKTOP_QUERY, useMediaQuery } from "@band-app/ui";

export { DESKTOP_QUERY };

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
