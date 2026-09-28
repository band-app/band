import type { Locator } from "@playwright/test";

export interface EdgeColors {
  /** Computed `border-top-color` of the element under test. */
  edge: string;
  /** The theme's `--border` token, resolved to a computed colour. */
  themeBorder: string;
  /** The theme's `--foreground` token, resolved to a computed colour. A bare
   *  Tailwind v4 `border` falls back to this (currentColor). */
  foreground: string;
}

/**
 * Read an element's top edge colour next to the theme's `--border` and
 * `--foreground` tokens. The tokens are resolved through a throwaway probe
 * element so all three strings come out of `getComputedStyle` in the same
 * colour syntax and can be compared with `toBe`.
 */
export async function readEdgeColors(locator: Locator): Promise<EdgeColors> {
  // Wait for the open animation so the colour isn't read mid-fade.
  await locator.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
  );
  return locator.evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.border = "1px solid var(--border)";
    probe.style.color = "var(--foreground)";
    el.ownerDocument.body.appendChild(probe);
    const probeStyle = getComputedStyle(probe);
    const colors = {
      edge: getComputedStyle(el).borderTopColor,
      themeBorder: probeStyle.borderTopColor,
      foreground: probeStyle.color,
    };
    probe.remove();
    return colors;
  });
}
