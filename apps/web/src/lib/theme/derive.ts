/**
 * Turns three colors (accent, background, foreground) into the whole token
 * set: surfaces, borders, muted text, selection, terminal, plus the preset's
 * semantic, terminal and syntax colors. Pure, so it is unit tested.
 */

import {
  contrast,
  ensureContrast,
  isDarkColor,
  mix,
  parseHex,
  type Rgb,
  readableOn,
  toHex,
  toRgba,
} from "./color";

export interface ColorTriple {
  accent: string;
  background: string;
  foreground: string;
}

/** The hues a preset supplies. Semantic, terminal and syntax colors come from them. */
export interface PresetHues {
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  orange: string;
  /** Comment and dim text in code. */
  comment: string;
  /** ANSI black and white, which a theme tunes to its own background. */
  black: string;
  white: string;
}

export type CssVars = Record<string, string>;

/** Contrast the derivation aims for. WCAG AA is 4.5; the margin covers rounding to 8-bit hex. */
export const TEXT_CONTRAST = 4.6;

function rgb(hex: string, fallback: string): Rgb {
  return parseHex(hex) ?? (parseHex(fallback) as Rgb);
}

/** The structural tokens derived from the three chosen colors. */
export function deriveSurfaceVars(colors: ColorTriple): CssVars {
  const bg = rgb(colors.background, "#1e1e1e");
  const dark = isDarkColor(bg);
  const fg = ensureContrast(rgb(colors.foreground, "#e8e8e8"), bg, TEXT_CONTRAST);
  const accent = rgb(colors.accent, "#3b82f6");

  const toward = (t: number) => mix(bg, fg, t);
  // Raised surfaces lean toward the text color. On a mid-tone background that
  // can leave no room for readable muted text, so ease them back until it fits.
  let muted = toward(0.07);
  let popover = dark ? toward(0.1) : bg;
  let mutedFg = fg;
  for (let k = 1; k >= 0; k -= 0.1) {
    muted = toward(0.07 * k);
    popover = dark ? toward(0.1 * k) : bg;
    mutedFg = ensureContrast(mix(fg, bg, 0.4), [bg, muted, popover], TEXT_CONTRAST);
    if (
      Math.min(contrast(mutedFg, bg), contrast(mutedFg, muted), contrast(mutedFg, popover)) >=
      TEXT_CONTRAST
    )
      break;
  }
  const accentText = ensureContrast(accent, [bg, popover], TEXT_CONTRAST);
  const primaryFg = readableOn(accent);

  return {
    "--background": toHex(bg),
    "--foreground": toHex(fg),
    "--card": toHex(toward(0.02)),
    "--card-foreground": toHex(fg),
    "--popover": toHex(popover),
    "--popover-foreground": toHex(fg),
    "--primary": toHex(accent),
    "--primary-foreground": toHex(primaryFg),
    "--secondary": toHex(muted),
    "--secondary-foreground": toHex(fg),
    "--muted": toHex(muted),
    "--muted-foreground": toHex(mutedFg),
    "--accent": toHex(toward(0.09)),
    "--accent-foreground": toHex(fg),
    "--sidebar": toHex(toward(0.04)),
    "--border": toHex(toward(dark ? 0.18 : 0.14)),
    "--input": toHex(toward(0.12)),
    "--ring": toHex(toward(0.4)),
    "--highlight": toHex(accentText),
    "--link": toHex(accentText),
    "--terminal-background": toHex(bg),
    "--terminal-foreground": toHex(fg),
    "--terminal-selection": toRgba(fg, dark ? 0.2 : 0.15),
    "--editor-active-line": toRgba(fg, 0.03),
  };
}

/** Semantic, terminal and syntax colors from a preset's hues, checked against the background. */
export function deriveHueVars(hues: PresetHues, background: string, foreground: string): CssVars {
  const bg = rgb(background, "#1e1e1e");
  const dark = isDarkColor(bg);
  const fg = ensureContrast(rgb(foreground, "#e8e8e8"), bg, TEXT_CONTRAST);
  const text = (hex: string) => ensureContrast(rgb(hex, "#888888"), bg, TEXT_CONTRAST);
  const ink = (hex: string) => ensureContrast(rgb(hex, "#888888"), bg, 3);

  const success = text(hues.green);
  const warning = text(hues.yellow);
  const danger = text(hues.red);
  const info = text(hues.blue);
  const merged = text(hues.magenta);
  const orange = text(hues.orange);

  const vars: CssVars = {
    "--success": toHex(success),
    "--warning": toHex(warning),
    "--danger": toHex(danger),
    "--info": toHex(info),
    "--merged": toHex(merged),
    "--success-foreground": toHex(readableOn(success)),
    "--warning-foreground": toHex(readableOn(warning)),
    "--danger-foreground": toHex(readableOn(danger)),
    "--info-foreground": toHex(readableOn(info)),
    "--merged-foreground": toHex(readableOn(merged)),
    "--destructive": toHex(danger),
    "--destructive-foreground": toHex(readableOn(danger)),
    "--status-foreground": toHex(readableOn(orange)),
    "--diff-added-bg": toRgba(success, 0.1),
    "--diff-removed-bg": toRgba(danger, 0.1),
    "--diff-added-marker": toRgba(success, 0.8),
    "--diff-removed-marker": toRgba(danger, 0.8),
    "--git-untracked": toHex(warning),
    "--git-behind": toHex(warning),
    "--git-diverged": toHex(orange),
    "--status-working": toHex(warning),
    "--status-question": toHex(orange),
    "--status-done": toHex(success),
    "--status-failed": toHex(danger),
    "--search-match": toRgba(rgb(hues.yellow, "#ffd33d"), 0.35),
    "--search-match-current": toRgba(rgb(hues.orange, "#f97316"), 0.8),
  };

  const bright = (hex: string) => (dark ? mix(rgb(hex, "#888888"), fg, 0.25) : rgb(hex, "#888888"));
  const ansi: Rgb[] = [
    rgb(hues.black, "#000000"),
    ink(hues.red),
    ink(hues.green),
    ink(hues.yellow),
    ink(hues.blue),
    ink(hues.magenta),
    ink(hues.cyan),
    rgb(hues.white, "#e5e5e5"),
    rgb(hues.comment, "#666666"),
    ink(toHex(bright(hues.red))),
    ink(toHex(bright(hues.green))),
    ink(toHex(bright(hues.yellow))),
    ink(toHex(bright(hues.blue))),
    ink(toHex(bright(hues.magenta))),
    ink(toHex(bright(hues.cyan))),
    fg,
  ];
  ansi.forEach((c, i) => {
    vars[`--ansi-${i}`] = toHex(c);
  });

  const syntax: Record<string, Rgb> = {
    comment: ensureContrast(rgb(hues.comment, "#888888"), bg, 3),
    keyword: text(hues.magenta),
    control: text(hues.magenta),
    string: text(hues.green),
    number: orange,
    function: info,
    variable: danger,
    type: warning,
    property: text(hues.cyan),
    operator: text(hues.cyan),
    tag: danger,
    attribute: orange,
    punctuation: fg,
    constant: orange,
    regexp: text(hues.cyan),
    heading: info,
    inserted: success,
    deleted: danger,
    invalid: danger,
  };
  for (const [name, c] of Object.entries(syntax)) vars[`--syntax-${name}`] = toHex(c);
  return vars;
}

/** Contrast of the pairs the derivation promises, for tests and the settings hint. */
export function derivedContrasts(colors: ColorTriple): {
  foregroundOnBackground: number;
  mutedForegroundOnMuted: number;
  mutedForegroundOnBackground: number;
} {
  const vars = deriveSurfaceVars(colors);
  const get = (name: string) => rgb(vars[name] as string, "#000000");
  return {
    foregroundOnBackground: contrast(get("--foreground"), get("--background")),
    mutedForegroundOnMuted: contrast(get("--muted-foreground"), get("--muted")),
    mutedForegroundOnBackground: contrast(get("--muted-foreground"), get("--background")),
  };
}
