import { useCallback, useEffect, useState } from "react";

import { useHubSession } from "./hub-session";
import { type GroupBy, parseGroupBy } from "./worktree-list";

/** The mobile list's "Group by" choice, kept in client state under one key (per device type). */
export const GROUP_BY_KEY = "band.mobile.group-by";

export function useGroupBy(): [GroupBy, (value: GroupBy) => void] {
  const { clientState, clientStateReady } = useHubSession();
  const [value, setValue] = useState<GroupBy>(() =>
    parseGroupBy(clientState.getItem(GROUP_BY_KEY)),
  );

  // oxlint-disable-next-line react/exhaustive-deps -- clientStateReady re-reads the saved copy once it is loaded
  useEffect(() => {
    setValue(parseGroupBy(clientState.getItem(GROUP_BY_KEY)));
    return clientState.subscribe((change) => {
      if (change.key === GROUP_BY_KEY) setValue(parseGroupBy(clientState.getItem(GROUP_BY_KEY)));
    });
  }, [clientState, clientStateReady]);

  const set = useCallback(
    (next: GroupBy) => {
      setValue(next);
      clientState.setItem(GROUP_BY_KEY, next);
    },
    [clientState],
  );
  return [value, set];
}
