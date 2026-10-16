import { DarkTheme, DefaultTheme, type Theme } from "expo-router";
import { type ColorValue, DynamicColorIOS, Platform, useColorScheme } from "react-native";

/**
 * A color with a light and a dark value. On iOS it is a dynamic color, so it follows the system
 * appearance in a plain `StyleSheet` with no re-render; elsewhere the dark value is used.
 */
export function dynamic(light: string, dark: string): ColorValue {
  return Platform.OS === "ios" ? DynamicColorIOS({ light, dark }) : dark;
}

/** The Cursor-style palette of the design demo (`.am/refs/design-demo.html`), light and dark. */
export const colors = {
  background: dynamic("#f5f5f4", "#0c0a09"),
  foreground: dynamic("#1c1917", "#f5f5f4"),
  card: dynamic("#fcfcfb", "#1c1917"),
  /** A quiet surface: chips, fields, the user's bubble. */
  muted: dynamic("#efedeb", "#292524"),
  mutedForeground: dynamic("#78716c", "#a8a29e"),
  faint: dynamic("#a8a29e", "#78716c"),
  border: dynamic("#e7e5e4", "#2e2a27"),
  /** The hairline between rows inside a grouped card. */
  divider: dynamic("#f0eeec", "#262220"),
  primary: dynamic("#1c1917", "#f5f5f4"),
  primaryForeground: dynamic("#fafaf9", "#0c0a09"),
  destructive: dynamic("#dc2626", "#f87171"),
  success: dynamic("#16a34a", "#22c55e"),
  warning: dynamic("#d97706", "#f59e0b"),
  /** Glass circles, pills and the floating composer sit on this over a blur. */
  glass: dynamic("rgba(252,252,251,0.82)", "rgba(28,25,23,0.78)"),
  scrim: dynamic("rgba(28,25,23,0.28)", "rgba(0,0,0,0.55)"),
  grab: dynamic("#d6d3d1", "#44403c"),
};

/** `light` or `dark`, for the few places that need the value (blur tint, status bar). */
export function useScheme(): "light" | "dark" {
  return useColorScheme() === "light" ? "light" : "dark";
}

/** The shadow of a floating glass control. */
export const floating = {
  shadowColor: "#000",
  shadowOpacity: 0.08,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
} as const;

export const navigationLight: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: "#f5f5f4",
    card: "#f5f5f4",
    text: "#1c1917",
    border: "#e7e5e4",
    primary: "#1c1917",
  },
};

export const navigationDark: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "#0c0a09",
    card: "#0c0a09",
    text: "#f5f5f4",
    border: "#2e2a27",
    primary: "#f5f5f4",
  },
};

/** Agent and badge colors. Attention is the one that must stand out from the rest of the row. */
export const tones = {
  running: dynamic("#3b82f6", "#60a5fa"),
  attention: dynamic("#d97706", "#f59e0b"),
  success: dynamic("#16a34a", "#22c55e"),
  failure: dynamic("#dc2626", "#f87171"),
  pending: dynamic("#d97706", "#f59e0b"),
  merged: dynamic("#8b5cf6", "#a78bfa"),
  neutral: dynamic("#a8a29e", "#78716c"),
};

/** Soft backgrounds for the PR number and tags, behind the tone's text. */
export const tints = {
  success: dynamic("#f0fdf4", "rgba(34,197,94,0.14)"),
  failure: dynamic("#fef2f2", "rgba(248,113,113,0.14)"),
  pending: dynamic("#fffbeb", "rgba(245,158,11,0.14)"),
  merged: dynamic("#f5f3ff", "rgba(167,139,250,0.14)"),
  neutral: dynamic("#f1f0ef", "#292524"),
};

export const fonts = {
  mono: "Menlo",
};

/** The chat's extra surfaces: code, diffs, links and the user's bubble. */
export const chatColors = {
  bubble: dynamic("#e9e7e5", "#292524"),
  bubbleBorder: dynamic("rgba(28,25,23,0.08)", "rgba(255,255,255,0.2)"),
  code: dynamic("#efedeb", "#292524"),
  inlineCode: dynamic("#e7e5e4", "#292524"),
  link: dynamic("#2563eb", "#60a5fa"),
  added: "rgba(34,197,94,0.15)",
  removed: "rgba(239,68,68,0.15)",
  addedText: dynamic("#16a34a", "#22c55e"),
};

/**
 * The terminal is dark in both appearances, like the web's. These are plain `#rrggbb` strings
 * because the native view parses them.
 */
export const terminalColors = {
  background: "#0c0a09",
  foreground: "#e7e5e4",
  bar: "#1c1917",
  key: "#292524",
  keyOn: "#e7e5e4",
  keyOnLabel: "#0c0a09",
  keyLabel: "#e7e5e4",
  status: "#a8a29e",
};

/** highlight.js scopes in GitHub's light and dark palettes. */
export const codeColors: Record<string, ColorValue> = {
  keyword: dynamic("#cf222e", "#ff7b72"),
  doctag: dynamic("#cf222e", "#ff7b72"),
  "template-tag": dynamic("#cf222e", "#ff7b72"),
  "template-variable": dynamic("#cf222e", "#ff7b72"),
  type: dynamic("#cf222e", "#ff7b72"),
  title: dynamic("#8250df", "#d2a8ff"),
  attr: dynamic("#0550ae", "#79c0ff"),
  attribute: dynamic("#0550ae", "#79c0ff"),
  literal: dynamic("#0550ae", "#79c0ff"),
  meta: dynamic("#0550ae", "#79c0ff"),
  number: dynamic("#0550ae", "#79c0ff"),
  operator: dynamic("#0550ae", "#79c0ff"),
  variable: dynamic("#953800", "#ffa657"),
  "selector-attr": dynamic("#0550ae", "#79c0ff"),
  "selector-class": dynamic("#0550ae", "#79c0ff"),
  "selector-id": dynamic("#0550ae", "#79c0ff"),
  regexp: dynamic("#0a3069", "#a5d6ff"),
  string: dynamic("#0a3069", "#a5d6ff"),
  built_in: dynamic("#953800", "#ffa657"),
  symbol: dynamic("#953800", "#ffa657"),
  comment: dynamic("#6e7781", "#8b949e"),
  code: dynamic("#6e7781", "#8b949e"),
  formula: dynamic("#6e7781", "#8b949e"),
  name: dynamic("#116329", "#7ee787"),
  quote: dynamic("#116329", "#7ee787"),
  "selector-tag": dynamic("#116329", "#7ee787"),
  "selector-pseudo": dynamic("#116329", "#7ee787"),
  subst: dynamic("#24292f", "#c9d1d9"),
  section: dynamic("#0550ae", "#1f6feb"),
  bullet: dynamic("#4d2d00", "#f2cc60"),
  addition: dynamic("#116329", "#aff5b4"),
  deletion: dynamic("#82071e", "#ffdcd7"),
};
