import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { buildSymbolMarkup } from "../src/dashboard/lib/file-icon-symbol.ts";

const require = createRequire(import.meta.url);
const iconsDir = join(dirname(require.resolve("material-icon-theme/package.json")), "icons");
const files = readdirSync(iconsDir).filter((f) => f.endsWith(".svg"));

function rootTag(src: string): string {
  return src.match(/<svg[^>]*>/)?.[0] ?? "";
}

describe("buildSymbolMarkup", () => {
  it("moves the root fill onto the symbol so unfilled paths stay transparent", () => {
    const src = readFileSync(join(iconsDir, "readme.svg"), "utf8");
    const symbol = buildSymbolMarkup("mit-readme", src);
    expect(symbol).toMatch(/^<symbol id="mit-readme" viewBox="0 0 16 16" fill="none">/);
  });

  it("carries the root presentation attributes of every icon in the theme", () => {
    expect(files.length).toBeGreaterThan(1000);
    let withRootPaint = 0;
    for (const file of files) {
      const src = readFileSync(join(iconsDir, file), "utf8");
      const symbol = buildSymbolMarkup(`mit-${file}`, src);
      expect(symbol, file).not.toBeNull();
      const symbolTag = symbol?.match(/<symbol[^>]*>/)?.[0] ?? "";
      for (const name of ["fill", "stroke", "stroke-width", "fill-rule", "clip-rule"]) {
        const value = rootTag(src).match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
        if (value === undefined) continue;
        withRootPaint++;
        expect(symbolTag, `${file} ${name}`).toContain(`${name}="${value}"`);
      }
    }
    expect(withRootPaint).toBeGreaterThan(0);
  });
});
