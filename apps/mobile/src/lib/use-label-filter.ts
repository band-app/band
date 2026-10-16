import { useCallback, useEffect, useState } from "react";
import { useHubSession } from "./hub-session";
import { LABEL_FILTER_KEY, parseLabelFilter } from "./label-filter";

/** The mobile list's label filter. It is the phone's own, not the web's `band.repos-list.label-filter`. */
export function useLabelFilter(): [string | null, (value: string | null) => void] {
  const { clientState, clientStateReady } = useHubSession();
  const [value, setValue] = useState<string | null>(() =>
    parseLabelFilter(clientState.getItem(LABEL_FILTER_KEY)),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: clientStateReady re-reads the saved copy once it is loaded
  useEffect(() => {
    setValue(parseLabelFilter(clientState.getItem(LABEL_FILTER_KEY)));
    return clientState.subscribe((change) => {
      if (change.key === LABEL_FILTER_KEY) {
        setValue(parseLabelFilter(clientState.getItem(LABEL_FILTER_KEY)));
      }
    });
  }, [clientState, clientStateReady]);

  const set = useCallback(
    (next: string | null) => {
      setValue(next);
      if (next === null) clientState.removeItem(LABEL_FILTER_KEY);
      else clientState.setItem(LABEL_FILTER_KEY, next);
    },
    [clientState],
  );
  return [value, set];
}
