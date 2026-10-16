/**
 * Theme presets. "Band" is the look the app shipped with and lives in
 * styles/globals.css, so it carries no values here. The others each give a
 * light and a dark variant: the three main colors plus the hues the semantic,
 * terminal and syntax colors are built from (see derive.ts).
 */

import type { ColorTriple, PresetHues } from "./derive";

export const BAND_PRESET_ID = "band";

export interface PresetVariant {
  colors: ColorTriple;
  hues: PresetHues;
}

export interface ThemePreset {
  id: string;
  label: string;
  /** Null for Band: its values are the CSS defaults. */
  light: PresetVariant | null;
  dark: PresetVariant | null;
}

/** Default accent / background / foreground shown for the Band preset. */
export const BAND_COLORS: { light: ColorTriple; dark: ColorTriple } = {
  light: { accent: "#155dfc", background: "#ffffff", foreground: "#0a0a0a" },
  dark: { accent: "#51a2ff", background: "#1e1e1e", foreground: "#e5e5e5" },
};

export const PRESETS: ThemePreset[] = [
  { id: BAND_PRESET_ID, label: "Band", light: null, dark: null },
  {
    id: "github",
    label: "GitHub",
    light: {
      colors: { accent: "#0969da", background: "#ffffff", foreground: "#1f2328" },
      hues: {
        red: "#cf222e",
        green: "#1a7f37",
        yellow: "#9a6700",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        orange: "#bc4c00",
        comment: "#6e7781",
        black: "#24292f",
        white: "#6e7781",
      },
    },
    dark: {
      colors: { accent: "#2f81f7", background: "#0d1117", foreground: "#e6edf3" },
      hues: {
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        orange: "#ffa657",
        comment: "#8b949e",
        black: "#484f58",
        white: "#b1bac4",
      },
    },
  },
  {
    id: "solarized",
    label: "Solarized",
    light: {
      colors: { accent: "#268bd2", background: "#fdf6e3", foreground: "#586e75" },
      hues: {
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        orange: "#cb4b16",
        comment: "#93a1a1",
        black: "#073642",
        white: "#93a1a1",
      },
    },
    dark: {
      colors: { accent: "#268bd2", background: "#002b36", foreground: "#93a1a1" },
      hues: {
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        orange: "#cb4b16",
        comment: "#586e75",
        black: "#073642",
        white: "#eee8d5",
      },
    },
  },
  {
    id: "nord",
    label: "Nord",
    light: {
      colors: { accent: "#5e81ac", background: "#eceff4", foreground: "#2e3440" },
      hues: {
        red: "#bf616a",
        green: "#7a9a5e",
        yellow: "#a98a45",
        blue: "#5e81ac",
        magenta: "#b48ead",
        cyan: "#4c8f98",
        orange: "#c0795a",
        comment: "#7b88a1",
        black: "#3b4252",
        white: "#7b88a1",
      },
    },
    dark: {
      colors: { accent: "#88c0d0", background: "#2e3440", foreground: "#d8dee9" },
      hues: {
        red: "#bf616a",
        green: "#a3be8c",
        yellow: "#ebcb8b",
        blue: "#81a1c1",
        magenta: "#b48ead",
        cyan: "#88c0d0",
        orange: "#d08770",
        comment: "#616e88",
        black: "#3b4252",
        white: "#e5e9f0",
      },
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    light: {
      colors: { accent: "#8839ef", background: "#eff1f5", foreground: "#4c4f69" },
      hues: {
        red: "#d20f39",
        green: "#40a02b",
        yellow: "#df8e1d",
        blue: "#1e66f5",
        magenta: "#ea76cb",
        cyan: "#179299",
        orange: "#fe640b",
        comment: "#8c8fa1",
        black: "#5c5f77",
        white: "#acb0be",
      },
    },
    dark: {
      colors: { accent: "#cba6f7", background: "#1e1e2e", foreground: "#cdd6f4" },
      hues: {
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        orange: "#fab387",
        comment: "#6c7086",
        black: "#45475a",
        white: "#bac2de",
      },
    },
  },
];

export function findPreset(id: string): ThemePreset {
  return PRESETS.find((p) => p.id === id) ?? (PRESETS[0] as ThemePreset);
}
