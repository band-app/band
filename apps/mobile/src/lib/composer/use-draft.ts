import { useCallback, useEffect, useRef, useState } from "react";

import { useHubSession } from "../hub-session";

/** The web composer's key (`band-draft:<worktree id>`), so a draft is the same on every device. */
export const draftKey = (worktreeId: string) => `band-draft:${worktreeId}`;

/**
 * The composer's text for a worktree's chat. The client-state store keeps it, so it survives
 * leaving the screen, the app going to the background and a restart, and the hub shares it
 * with the other devices. Read once the saved state has loaded; typing before then wins.
 */
export function useDraft(worktreeId: string): [string, (text: string) => void] {
  const { clientState, clientStateReady } = useHubSession();
  const key = draftKey(worktreeId);
  const [text, setTextState] = useState(() => clientState.getItem(key) ?? "");
  const touched = useRef(false);

  // oxlint-disable-next-line react/exhaustive-deps -- clientStateReady re-reads the saved copy once it is loaded
  useEffect(() => {
    if (!touched.current) setTextState(clientState.getItem(key) ?? "");
  }, [clientState, key, clientStateReady]);

  const setText = useCallback(
    (next: string) => {
      touched.current = true;
      setTextState(next);
      if (next) clientState.setItem(key, next);
      else clientState.removeItem(key);
    },
    [clientState, key],
  );

  return [text, setText];
}
