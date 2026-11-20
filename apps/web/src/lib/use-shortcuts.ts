import { useSyncExternalStore } from "react";
import { getOverrides, type ShortcutOverrides, subscribeShortcuts } from "./shortcuts";

/** The user's shortcut overrides; the component re-renders when one changes. */
export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(subscribeShortcuts, getOverrides, getOverrides);
}
