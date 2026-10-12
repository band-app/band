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

/** Agent and badge colors. Attention is the one that must stand out from the rest of the row. */
export const tones = {
  running: "#60a5fa",
  attention: "#fb923c",
  success: "#4ade80",
  failure: "#ff6467",
  pending: "#facc15",
  merged: "#a78bfa",
  neutral: "#8a8a8a",
};

export const fonts = {
  mono: "Menlo",
};

/** The chat's extra surfaces: code, diffs, links and the user's bubble. */
export const chatColors = {
  bubble: "#2a2a2a",
  bubbleBorder: "rgba(255,255,255,0.2)",
  code: "#161616",
  inlineCode: "#2c2c2c",
  link: "#60a5fa",
  added: "rgba(34,197,94,0.15)",
  removed: "rgba(239,68,68,0.15)",
  addedText: "#4ade80",
};

/** highlight.js scopes in GitHub's dark palette, the theme the web chat's code blocks use. */
export const codeColors: Record<string, string> = {
  keyword: "#ff7b72",
  doctag: "#ff7b72",
  "template-tag": "#ff7b72",
  "template-variable": "#ff7b72",
  type: "#ff7b72",
  title: "#d2a8ff",
  attr: "#79c0ff",
  attribute: "#79c0ff",
  literal: "#79c0ff",
  meta: "#79c0ff",
  number: "#79c0ff",
  operator: "#79c0ff",
  variable: "#ffa657",
  "selector-attr": "#79c0ff",
  "selector-class": "#79c0ff",
  "selector-id": "#79c0ff",
  regexp: "#a5d6ff",
  string: "#a5d6ff",
  built_in: "#ffa657",
  symbol: "#ffa657",
  comment: "#8b949e",
  code: "#8b949e",
  formula: "#8b949e",
  name: "#7ee787",
  quote: "#7ee787",
  "selector-tag": "#7ee787",
  "selector-pseudo": "#7ee787",
  subst: "#c9d1d9",
  section: "#1f6feb",
  bullet: "#f2cc60",
  addition: "#aff5b4",
  deletion: "#ffdcd7",
};
