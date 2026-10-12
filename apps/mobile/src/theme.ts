import { DarkTheme, type Theme } from "expo-router";

/** The web app's dark palette (`packages/ui/src/globals.css`), as hex for React Native. */
export const colors = {
  background: "#1e1e1e",
  foreground: "#e5e5e5",
  card: "#1a1a1a",
  muted: "#262626",
  mutedForeground: "#8a8a8a",
  border: "#3a3a3a",
  primary: "#e5e5e5",
  primaryForeground: "#171717",
  destructive: "#ff6467",
  success: "#4ade80",
  warning: "#facc15",
};

export const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
    text: colors.foreground,
    border: colors.border,
    primary: colors.foreground,
  },
};
