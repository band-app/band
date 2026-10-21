import { useCallback, useEffect, useState } from "react";
import { GROUP_FILTER_KEY, parseGroupFilter } from "./group-filter";
import { useHubSession } from "./hub-session";

/** The mobile list's group filter. It is the phone's own, not the web's `band.repos-list.group-filter`. */
export function useGroupFilter(): [string | null, (value: string | null) => void] {
  const { clientState, clientStateReady } = useHubSession();
  const [value, setValue] = useState<string | null>(() =>
    parseGroupFilter(clientState.getItem(GROUP_FILTER_KEY)),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: clientStateReady re-reads the saved copy once it is loaded
  useEffect(() => {
    setValue(parseGroupFilter(clientState.getItem(GROUP_FILTER_KEY)));
    return clientState.subscribe((change) => {
      if (change.key === GROUP_FILTER_KEY) {
        setValue(parseGroupFilter(clientState.getItem(GROUP_FILTER_KEY)));
      }
    });
  }, [clientState, clientStateReady]);

  const set = useCallback(
    (next: string | null) => {
      setValue(next);
      if (next === null) clientState.removeItem(GROUP_FILTER_KEY);
      else clientState.setItem(GROUP_FILTER_KEY, next);
    },
    [clientState],
  );
  return [value, set];
}
