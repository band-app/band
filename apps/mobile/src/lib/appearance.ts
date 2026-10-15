import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { Appearance } from "react-native";

/** The user's pick: follow the system, or force light or dark. Kept on this device only. */
export type AppearanceChoice = "system" | "light" | "dark";

export const APPEARANCE_KEY = "band.mobile.appearance";

export const APPEARANCE_OPTIONS: { value: AppearanceChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function parseAppearance(raw: string | null): AppearanceChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** Tells iOS which appearance the app's windows use; `unspecified` hands it back to the system. */
export function applyAppearance(choice: AppearanceChoice): void {
  Appearance.setColorScheme(choice === "system" ? "unspecified" : choice);
}

/** Reads the saved choice at start and applies it. */
export async function restoreAppearance(): Promise<AppearanceChoice> {
  let choice: AppearanceChoice = "system";
  try {
    choice = parseAppearance(await AsyncStorage.getItem(APPEARANCE_KEY));
  } catch {
    // Unreadable storage leaves the system appearance.
  }
  applyAppearance(choice);
  return choice;
}

export function useAppearance(): [AppearanceChoice, (choice: AppearanceChoice) => void] {
  const [choice, setChoice] = useState<AppearanceChoice>("system");
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(APPEARANCE_KEY).then(
      (raw) => {
        if (!cancelled) setChoice(parseAppearance(raw));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const set = useCallback((next: AppearanceChoice) => {
    setChoice(next);
    applyAppearance(next);
    void AsyncStorage.setItem(APPEARANCE_KEY, next).catch(() => {});
  }, []);
  return [choice, set];
}
