import { useCallback, useEffect, useMemo, useState } from "react";
import {
  COLLAPSED_REPOS_KEY,
  parseCollapsed,
  setCollapsedMany,
  toggleCollapsed,
} from "./collapsed-repos";
import { useHubSession } from "./hub-session";

/** The collapsed repo names, shared with the server so they survive a reinstall of the app's cache. */
export function useCollapsedRepos() {
  const { clientState, clientStateReady } = useHubSession();
  const [raw, setRaw] = useState<string | null>(() => clientState.getItem(COLLAPSED_REPOS_KEY));

  // The saved copy is read into memory once the session is ready, and another device may change it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clientStateReady re-reads the saved copy once it is loaded
  useEffect(() => {
    setRaw(clientState.getItem(COLLAPSED_REPOS_KEY));
    return clientState.subscribe((change) => {
      if (change.key === COLLAPSED_REPOS_KEY) setRaw(clientState.getItem(COLLAPSED_REPOS_KEY));
    });
  }, [clientState, clientStateReady]);

  const toggle = useCallback(
    (repo: string) => {
      const next = toggleCollapsed(clientState.getItem(COLLAPSED_REPOS_KEY), repo);
      if (next === null) clientState.removeItem(COLLAPSED_REPOS_KEY);
      else clientState.setItem(COLLAPSED_REPOS_KEY, next);
      setRaw(next);
    },
    [clientState],
  );

  const setMany = useCallback(
    (names: readonly string[], value: boolean) => {
      const next = setCollapsedMany(clientState.getItem(COLLAPSED_REPOS_KEY), names, value);
      if (next === null) clientState.removeItem(COLLAPSED_REPOS_KEY);
      else clientState.setItem(COLLAPSED_REPOS_KEY, next);
      setRaw(next);
    },
    [clientState],
  );

  const collapsed = useMemo(() => parseCollapsed(raw), [raw]);
  return { collapsed, toggle, setMany };
}
