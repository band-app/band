import { describe, expect, it } from "vitest";
import { contrast, normalizeHex, parseHex } from "../src/lib/theme/color";
import {
  type ColorTriple,
  derivedContrasts,
  deriveSurfaceVars,
  LIST_HIGHLIGHT_CONTRAST,
} from "../src/lib/theme/derive";
import {
  DEFAULT_APPEARANCE,
  effectiveColors,
  isCustomized,
  parseAppearance,
  resolveColorVars,
  resolveFontVars,
} from "../src/lib/theme/model";
import { PRESETS } from "../src/lib/theme/presets";

// Pure functions: colors in, variables out. No state to fake.
const INPUTS: [string, ColorTriple][] = [
  ["very dark", { accent: "#3b82f6", background: "#000000", foreground: "#111111" }],
  ["very light", { accent: "#3b82f6", background: "#ffffff", foreground: "#fafafa" }],
  ["mid grey", { accent: "#ff00ff", background: "#808080", foreground: "#8a8a8a" }],
  ["saturated", { accent: "#00ff00", background: "#ff0000", foreground: "#00ffff" }],
  ["same color", { accent: "#123456", background: "#123456", foreground: "#123456" }],
  ["normal dark", { accent: "#0169cc", background: "#111111", foreground: "#fcfcfc" }],
  ["normal light", { accent: "#0969da", background: "#ffffff", foreground: "#1f2328" }],
];

describe("derived surfaces keep text readable", () => {
  for (const [name, colors] of INPUTS) {
    it(`${name}: foreground and muted foreground reach 4.5:1`, () => {
      const c = derivedContrasts(colors);
      expect(c.foregroundOnBackground).toBeGreaterThanOrEqual(4.5);
      expect(c.mutedForegroundOnMuted).toBeGreaterThanOrEqual(4.5);
      expect(c.mutedForegroundOnBackground).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: links and the accent read on the background`, () => {
      const vars = deriveSurfaceVars(colors);
      const bg = parseHex(vars["--background"] as string);
      const link = parseHex(vars["--link"] as string);
      if (!bg || !link) throw new Error("derived colors must be hex");
      expect(contrast(link, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("emits every surface token as a hex color", () => {
    const vars = deriveSurfaceVars(INPUTS[5]?.[1] as ColorTriple);
    for (const key of ["--card", "--popover", "--muted", "--border", "--sidebar", "--ring"]) {
      expect(vars[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("list highlight", () => {
  const MORE: [string, ColorTriple][] = [
    [
      "dark low-saturation accent",
      { accent: "#777777", background: "#1e1e1e", foreground: "#d4d4d4" },
    ],
    [
      "light low-saturation accent",
      { accent: "#888888", background: "#fafafa", foreground: "#222222" },
    ],
    ["dark saturated accent", { accent: "#ff0066", background: "#0a0a14", foreground: "#e0e0ff" }],
    ["light saturated accent", { accent: "#00cc44", background: "#fffff0", foreground: "#202020" }],
  ];
  for (const [name, colors] of [...INPUTS, ...MORE]) {
    it(`${name}: stands out from the popover and page, text stays readable`, () => {
      const vars = deriveSurfaceVars(colors);
      const get = (k: string) =>
        parseHex(vars[k] as string) as NonNullable<ReturnType<typeof parseHex>>;
      const row = get("--list-highlight");
      expect(contrast(row, get("--popover"))).toBeGreaterThanOrEqual(LIST_HIGHLIGHT_CONTRAST);
      expect(contrast(row, get("--background"))).toBeGreaterThanOrEqual(LIST_HIGHLIGHT_CONTRAST);
      expect(contrast(get("--list-highlight-foreground"), row)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("presets", () => {
  it("every preset variant keeps its own colors readable", () => {
    for (const preset of PRESETS) {
      for (const variant of [preset.light, preset.dark]) {
        if (!variant) continue;
        const c = derivedContrasts(variant.colors);
        expect(c.foregroundOnBackground).toBeGreaterThanOrEqual(4.5);
        expect(c.mutedForegroundOnMuted).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("Band with no overrides sets no color variables, so the stylesheet applies", () => {
    expect(resolveColorVars(DEFAULT_APPEARANCE, "dark")).toEqual({});
    expect(resolveColorVars(DEFAULT_APPEARANCE, "light")).toEqual({});
  });

  it("another preset sets surface, terminal and syntax variables", () => {
    const vars = resolveColorVars({ ...DEFAULT_APPEARANCE, preset: "nord" }, "dark");
    expect(vars["--background"]).toBe("#2e3440");
    expect(vars["--ansi-1"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars["--syntax-keyword"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars["--success"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("an override applies to one mode only", () => {
    const appearance = { ...DEFAULT_APPEARANCE, overrides: { dark: { accent: "#ff0000" } } };
    expect(isCustomized(appearance)).toBe(true);
    expect(effectiveColors(appearance, "dark").accent).toBe("#ff0000");
    expect(resolveColorVars(appearance, "light")).toEqual({});
    expect(resolveColorVars(appearance, "dark")["--primary"]).toBe("#ff0000");
  });
});

describe("stored appearance", () => {
  it("drops malformed values and clamps sizes", () => {
    const parsed = parseAppearance(
      JSON.stringify({
        preset: "nope",
        overrides: { dark: { accent: "red", background: "#ABC" } },
        uiFont: "comic",
        uiFontSize: 99,
        codeFontSize: 2,
      }),
    );
    expect(parsed.preset).toBe("band");
    expect(parsed.overrides.dark).toEqual({ background: "#aabbcc" });
    expect(parsed.uiFont).toBe("system");
    expect(parsed.uiFontSize).toBe(22);
    expect(parsed.codeFontSize).toBe(9);
    expect(parseAppearance("not json")).toEqual(DEFAULT_APPEARANCE);
  });

  it("sets font variables only for non-default choices", () => {
    expect(resolveFontVars(DEFAULT_APPEARANCE)).toEqual({});
    const vars = resolveFontVars({
      ...DEFAULT_APPEARANCE,
      codeFont: "menlo",
      uiFontSize: 18,
      codeFontSize: 14,
    });
    expect(vars["--font-code"]).toContain("Menlo");
    expect(vars["--font-size-ui"]).toBe("18px");
    expect(vars["--code-font-size"]).toBe("14px");
    expect(resolveFontVars({ ...DEFAULT_APPEARANCE, uiFontSize: 16 })).toEqual({});
  });

  it("normalizes hex input", () => {
    expect(normalizeHex("#FFF")).toBe("#ffffff");
    expect(normalizeHex("12ab34")).toBe("#12ab34");
    expect(normalizeHex("blue")).toBeNull();
  });
});
