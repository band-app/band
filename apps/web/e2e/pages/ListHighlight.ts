/**
 * Reads how clearly a list's highlighted row differs from a normal row, from
 * computed styles. Used with a page object's own row locators, so a spec never
 * touches the DOM directly.
 */

import type { Locator } from "@playwright/test";

/** Relative luminance of a computed `rgb()` or `color(srgb ...)` string. */
function parseChannels(css: string): [number, number, number] {
  const nums = css.match(/-?\d*\.?\d+/g)?.map(Number) ?? [0, 0, 0];
  const scale = css.startsWith("color(") ? 255 : 1;
  return [nums[0] * scale, nums[1] * scale, nums[2] * scale] as [number, number, number];
}

function luminance(css: string): number {
  const [r, g, b] = parseChannels(css).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The computed background of a row, resolved to sRGB by the browser. A transparent row shows the nearest ancestor that paints. */
async function backgroundOf(row: Locator): Promise<string> {
  return await row.evaluate((el) => {
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const read = (css: string): [number, number, number, number] => {
      if (!probe) return [0, 0, 0, 255];
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0] as number, d[1] as number, d[2] as number, d[3] as number];
    };
    for (let node: Element | null = el; node; node = node.parentElement) {
      const [r, g, b, a] = read(getComputedStyle(node).backgroundColor);
      if (a === 255) return `rgb(${r}, ${g}, ${b})`;
    }
    return "rgb(0, 0, 0)";
  });
}

/** WCAG contrast ratio between the backgrounds of two rows. */
export async function rowContrast(highlighted: Locator, normal: Locator): Promise<number> {
  const a = luminance(await backgroundOf(highlighted));
  const b = luminance(await backgroundOf(normal));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
