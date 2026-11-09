/** The AppKit colors a mod may use, as `--mac-*` CSS variables on `:root`. */
export const SYSTEM_COLOR_VARS: Record<string, string> = {
  label: "--mac-label",
  "secondary-label": "--mac-label-secondary",
  "tertiary-label": "--mac-label-tertiary",
  "quaternary-label": "--mac-label-quaternary",
  separator: "--mac-separator",
  "selected-content-background": "--mac-selected-content",
  "unemphasized-selected-content-background": "--mac-selected-content-inactive",
  "window-background": "--mac-window-background",
  "control-background": "--mac-control-background",
  "under-page-background": "--mac-under-page",
  link: "--mac-link",
};

/** A `#RRGGBB` or `#RRGGBBAA` string, which CSS reads as is. Anything else is dropped. */
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export function systemColorsCss(
  getColor: (name: string) => string,
  accent: string,
  options: { symbols?: boolean } = {},
): string {
  const lines: string[] = [];
  for (const [name, variable] of Object.entries(SYSTEM_COLOR_VARS)) {
    try {
      const value = getColor(name);
      if (HEX.test(value)) lines.push(`${variable}:${value};`);
    } catch {
      // A name this macOS does not know is left out; the mod's fallback applies.
    }
  }
  const a = accent.startsWith("#") ? accent : `#${accent}`;
  if (HEX.test(a)) lines.push(`--mac-accent:${a.slice(0, 7)};`);
  // Set only when the native addon can render SF Symbols, so a mod keeps its own icons otherwise.
  if (options.symbols) lines.push("--mac-symbols:1;");
  return `:root{${lines.join("")}}`;
}

/** The parts of Electron that `watchSystemColors` uses, so a test can pass fakes. */
export interface SystemColorsHost {
  getColor(name: string): string;
  getAccentColor(): string;
  onChange(fn: () => void): () => void;
}

export interface CssTarget {
  insertCSS(css: string): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
  isDestroyed(): boolean;
  on(event: "did-finish-load", fn: () => void): unknown;
}

/** Delays after a change at which the colors are read again, in milliseconds. */
export const RESETTLE_MS = [120, 400];

/** Keeps the page's `--mac-*` variables current: on load, and when the appearance or accent changes. */
export function watchSystemColors(
  target: CssTarget,
  host: SystemColorsHost,
  options: { symbols?: boolean } = {},
): () => void {
  let key: string | null = null;
  let seq = 0;
  const apply = async () => {
    if (target.isDestroyed()) return;
    const mine = ++seq;
    const previous = key;
    key = null;
    if (previous) await target.removeInsertedCSS(previous).catch(() => {});
    const css = systemColorsCss(host.getColor.bind(host), host.getAccentColor(), options);
    const inserted = await target.insertCSS(css).catch(() => null);
    if (mine === seq) key = inserted;
  };
  target.on("did-finish-load", () => {
    key = null;
    void apply();
  });
  // The change event can arrive before AppKit's effective appearance has switched, so `getColor`
  // would still return the old values. Apply at once and again once the appearance has settled.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const offChange = host.onChange(() => {
    void apply();
    for (const delay of RESETTLE_MS) {
      const t = setTimeout(() => {
        timers.delete(t);
        void apply();
      }, delay);
      timers.add(t);
    }
  });
  void apply();
  return () => {
    offChange();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
