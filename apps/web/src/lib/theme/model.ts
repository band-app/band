/**
 * The appearance settings and how they resolve to CSS variables on <html>.
 * The theme (preset, colors, fonts, sizes) is synced client state under
 * `band-appearance`; the mode (system, light, dark) is per device under
 * `band-theme`, so System follows each device's OS.
 */

import { isHex, normalizeHex } from "./color";
import { type ColorTriple, deriveHueVars, deriveSurfaceVars } from "./derive";
import { BAND_COLORS, BAND_PRESET_ID, findPreset } from "./presets";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedMode = "light" | "dark";

export const APPEARANCE_KEY = "band-appearance";
export const MODE_KEY = "band-theme";
/** Resolved CSS variables per mode, read by the pre-paint script in __root.tsx. */
export const VARS_CACHE_KEY = "band-theme-vars";

export const DEFAULT_UI_FONT_SIZE = 16;
export const DEFAULT_CODE_FONT_SIZE = 13;
export const UI_FONT_SIZE_RANGE = { min: 11, max: 22 } as const;
export const CODE_FONT_SIZE_RANGE = { min: 9, max: 24 } as const;

export interface FontOption {
  id: string;
  label: string;
  /** A CSS font-family list that falls back cleanly when the font isn't installed. Null keeps the default. */
  stack: string | null;
}

const SYSTEM_UI_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const UI_FONTS: FontOption[] = [
  { id: "system", label: "System", stack: null },
  { id: "inter", label: "Inter", stack: `Inter, ${SYSTEM_UI_STACK}` },
  {
    id: "helvetica",
    label: "Helvetica Neue",
    stack: `"Helvetica Neue", Helvetica, Arial, sans-serif`,
  },
  { id: "serif", label: "Georgia", stack: `Georgia, "Times New Roman", serif` },
];

export const CODE_FONTS: FontOption[] = [
  { id: "system", label: "System", stack: null },
  {
    id: "sf-mono",
    label: "SF Mono",
    stack: `"SF Mono", SFMono-Regular, ui-monospace, Menlo, Monaco, monospace`,
  },
  { id: "menlo", label: "Menlo", stack: `Menlo, Monaco, "Courier New", monospace` },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    stack: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`,
  },
  {
    id: "fira-code",
    label: "Fira Code",
    stack: `"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace`,
  },
  { id: "consolas", label: "Consolas", stack: `Consolas, "Liberation Mono", Menlo, monospace` },
];

export type ColorKey = keyof ColorTriple;
export const COLOR_KEYS: ColorKey[] = ["accent", "background", "foreground"];

export interface Appearance {
  preset: string;
  /** Colors the user changed, per mode. A missing key means "the preset's". */
  overrides: { light?: Partial<ColorTriple>; dark?: Partial<ColorTriple> };
  uiFont: string;
  codeFont: string;
  /** Null means the default. */
  uiFontSize: number | null;
  codeFontSize: number | null;
}

export const DEFAULT_APPEARANCE: Appearance = {
  preset: BAND_PRESET_ID,
  overrides: {},
  uiFont: "system",
  codeFont: "system",
  uiFontSize: null,
  codeFontSize: null,
};

function clampSize(value: unknown, range: { min: number; max: number }): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function cleanOverrides(value: unknown): Partial<ColorTriple> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Partial<ColorTriple> = {};
  for (const key of COLOR_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === "string" && isHex(raw)) out[key] = normalizeHex(raw) as string;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Reads a stored value, dropping anything malformed. Never throws. */
export function parseAppearance(raw: string | null): Appearance {
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const light = cleanOverrides((v.overrides as Record<string, unknown> | undefined)?.light);
    const dark = cleanOverrides((v.overrides as Record<string, unknown> | undefined)?.dark);
    const preset = typeof v.preset === "string" ? findPreset(v.preset).id : BAND_PRESET_ID;
    const uiFont = UI_FONTS.some((f) => f.id === v.uiFont) ? (v.uiFont as string) : "system";
    const codeFont = CODE_FONTS.some((f) => f.id === v.codeFont)
      ? (v.codeFont as string)
      : "system";
    return {
      preset,
      overrides: { ...(light ? { light } : {}), ...(dark ? { dark } : {}) },
      uiFont,
      codeFont,
      uiFontSize: clampSize(v.uiFontSize, UI_FONT_SIZE_RANGE),
      codeFontSize: clampSize(v.codeFontSize, CODE_FONT_SIZE_RANGE),
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function serializeAppearance(a: Appearance): string {
  return JSON.stringify(a);
}

export function isDefaultAppearance(a: Appearance): boolean {
  return serializeAppearance(normalize(a)) === serializeAppearance(DEFAULT_APPEARANCE);
}

function normalize(a: Appearance): Appearance {
  return parseAppearance(serializeAppearance(a));
}

/** The three colors a mode shows: the preset's, then the user's overrides on top. */
export function effectiveColors(a: Appearance, mode: ResolvedMode): ColorTriple {
  const preset = findPreset(a.preset);
  const base = (mode === "dark" ? preset.dark : preset.light)?.colors ?? BAND_COLORS[mode];
  return { ...base, ...(a.overrides[mode] ?? {}) };
}

export function hasColorOverride(a: Appearance, mode: ResolvedMode): boolean {
  return Object.keys(a.overrides[mode] ?? {}).length > 0;
}

/** Whether a mode's colors differ from its preset, which the UI shows as "Custom". */
export function isCustomized(a: Appearance): boolean {
  return hasColorOverride(a, "light") || hasColorOverride(a, "dark");
}

/**
 * The CSS variables to set on <html> for a mode. Empty for the Band preset
 * with no color overrides: the stylesheet's own values apply.
 */
export function resolveColorVars(a: Appearance, mode: ResolvedMode): Record<string, string> {
  const preset = findPreset(a.preset);
  const variant = mode === "dark" ? preset.dark : preset.light;
  const overridden = hasColorOverride(a, mode);
  if (!variant && !overridden) return {};
  const colors = effectiveColors(a, mode);
  const vars = deriveSurfaceVars(colors);
  if (variant)
    Object.assign(vars, deriveHueVars(variant.hues, colors.background, colors.foreground));
  return vars;
}

/** Font and size variables. These don't depend on the mode. */
export function resolveFontVars(a: Appearance): Record<string, string> {
  const vars: Record<string, string> = {};
  const ui = UI_FONTS.find((f) => f.id === a.uiFont)?.stack;
  const code = CODE_FONTS.find((f) => f.id === a.codeFont)?.stack;
  if (ui) vars["--font-ui"] = ui;
  if (code) vars["--font-code"] = code;
  if (a.uiFontSize && a.uiFontSize !== DEFAULT_UI_FONT_SIZE) {
    vars["--font-size-ui"] = `${a.uiFontSize}px`;
  }
  if (a.codeFontSize) vars["--code-font-size"] = `${a.codeFontSize}px`;
  return vars;
}

export function resolveVars(a: Appearance, mode: ResolvedMode): Record<string, string> {
  return { ...resolveColorVars(a, mode), ...resolveFontVars(a) };
}

export function parseMode(raw: string | null): ThemeMode {
  return raw === "light" || raw === "system" ? raw : "dark";
}
