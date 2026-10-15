/**
 * Small color toolkit for the theme derivation: hex parsing, mixing in OKLab,
 * WCAG contrast and a contrast fixer. No dependencies, no DOM.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parses `#rgb` or `#rrggbb` (the `#` is optional). Returns null for anything else. */
export function parseHex(input: string): Rgb | null {
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  let h = m[1] as string;
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

export function isHex(input: string): boolean {
  return HEX_RE.test(input.trim());
}

/** `#rrggbb`, lowercase. */
export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Normalizes a user-typed hex to `#rrggbb`, or null when it is not a color. */
export function normalizeHex(input: string): string | null {
  const rgb = parseHex(input);
  return rgb ? toHex(rgb) : null;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: Rgb): number {
  return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

interface Lab {
  l: number;
  a: number;
  b: number;
}

function toOklab({ r, g, b }: Rgb): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function fromOklab({ l, a, b }: Lab): Rgb {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    g: linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    b: linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  };
}

/** `t` of the way from `from` to `to`, mixed in OKLab so greys stay grey. */
export function mix(from: Rgb, to: Rgb, t: number): Rgb {
  const a = toOklab(from);
  const b = toOklab(to);
  return fromOklab({
    l: a.l + (b.l - a.l) * t,
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * Moves `fg` toward white or black (whichever direction `against` allows)
 * until it reaches `ratio` against every color in `against`. Keeps its hue.
 * When even the extreme fails, returns the extreme that does best.
 */
export function ensureContrast(fg: Rgb, against: Rgb | Rgb[], ratio: number): Rgb {
  const list = Array.isArray(against) ? against : [against];
  const worst = (c: Rgb) => Math.min(...list.map((bg) => contrast(c, bg)));
  if (worst(fg) >= ratio) return fg;
  const meanLum = list.reduce((sum, c) => sum + luminance(c), 0) / list.length;
  const target = meanLum > 0.4 ? BLACK : WHITE;
  let best = fg;
  for (let i = 1; i <= 20; i++) {
    const candidate = mix(fg, target, i / 20);
    best = candidate;
    if (worst(candidate) >= ratio) return candidate;
  }
  // The pull toward the preferred end failed: try the other end.
  const other = target === BLACK ? WHITE : BLACK;
  return worst(other) > worst(best) ? other : best;
}

/** Black or white text, whichever reads better on `bg`. */
export function readableOn(bg: Rgb): Rgb {
  return contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
}

/** `rgba(r, g, b, a)` for xterm and other places that need an alpha color. */
export function toRgba(rgb: Rgb, alpha: number): string {
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`;
}

/** Whether `bg` is a dark surface. */
export function isDarkColor(bg: Rgb): boolean {
  return luminance(bg) < 0.18;
}
