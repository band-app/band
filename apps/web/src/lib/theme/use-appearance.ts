import { useMemo, useSyncExternalStore } from "react";

import { clientStorage } from "../client-state";
import { loadMode, THEME_CHANGED_EVENT } from "./apply";
import {
  APPEARANCE_KEY,
  type Appearance,
  parseAppearance,
  type ResolvedMode,
  type ThemeMode,
} from "./model";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The stored appearance and the device's mode, re-read whenever the theme changes. */
export function useAppearance(): {
  appearance: Appearance;
  mode: ThemeMode;
  resolvedMode: ResolvedMode;
} {
  const rawAppearance = useSyncExternalStore(
    subscribe,
    () => clientStorage.getItem(APPEARANCE_KEY),
    () => null,
  );
  const mode = useSyncExternalStore(subscribe, loadMode, () => "dark" as ThemeMode);
  const appearance = useMemo(() => parseAppearance(rawAppearance), [rawAppearance]);
  const resolvedMode = useSyncExternalStore(
    subscribe,
    (): ResolvedMode => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    (): ResolvedMode => "dark",
  );
  return { appearance, mode, resolvedMode };
}
