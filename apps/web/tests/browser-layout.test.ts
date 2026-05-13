/**
 * Pure-function tests for `injectInitialUrls`. This is the function that
 * seeds `params.initialUrl` on the restored dockview layout so reopened
 * tabs mount with their URL already in hand instead of having to round-
 * trip through `trpc.browsers.get` and racing the create-webview effect.
 *
 * The bugs this guards against:
 *   - Source layout being mutated (it lives in the React Query cache).
 *   - Empty / null `urls` map causing an unnecessary copy.
 *   - Overwriting an existing `initialUrl` that a legacy save carried.
 *   - Touching panels that aren't in the urls map.
 */

import { describe, expect, it } from "vitest";
import { injectInitialUrls } from "../src/lib/browser-layout";

function makeLayout(panels: Record<string, Record<string, unknown>>) {
  return { grid: {}, panels, activeGroup: null };
}

describe("injectInitialUrls", () => {
  it("returns the layout unchanged when urls is null", () => {
    const layout = makeLayout({ a: { id: "a", params: { browserId: "a" } } });
    expect(injectInitialUrls(layout, null)).toBe(layout);
  });

  it("returns the layout unchanged when urls is empty", () => {
    const layout = makeLayout({ a: { id: "a", params: { browserId: "a" } } });
    expect(injectInitialUrls(layout, new Map())).toBe(layout);
  });

  it("returns the input unchanged when it isn't a dockview-shaped object", () => {
    expect(injectInitialUrls(null, new Map([["a", "u"]]))).toBe(null);
    const arr: unknown = [1, 2, 3];
    expect(injectInitialUrls(arr, new Map([["a", "u"]]))).toBe(arr);
    const malformed = { grid: {} }; // no panels
    expect(injectInitialUrls(malformed, new Map([["a", "u"]]))).toBe(malformed);
  });

  it("injects initialUrl into matching panel params", () => {
    const layout = makeLayout({
      a: { id: "a", params: { workspaceId: "ws", browserId: "a" } },
      b: { id: "b", params: { workspaceId: "ws", browserId: "b" } },
    });
    const result = injectInitialUrls(
      layout,
      new Map([
        ["a", "https://example.com"],
        ["b", "https://other.test/path"],
      ]),
    ) as { panels: Record<string, { params: Record<string, unknown> }> };
    expect(result.panels.a.params.initialUrl).toBe("https://example.com");
    expect(result.panels.b.params.initialUrl).toBe("https://other.test/path");
    // Existing keys preserved.
    expect(result.panels.a.params.browserId).toBe("a");
    expect(result.panels.a.params.workspaceId).toBe("ws");
  });

  it("doesn't mutate the source layout", () => {
    const layout = makeLayout({ a: { id: "a", params: { browserId: "a" } } });
    const copy = JSON.parse(JSON.stringify(layout));
    injectInitialUrls(layout, new Map([["a", "https://example.com"]]));
    expect(layout).toEqual(copy);
  });

  it("respects an existing initialUrl on the saved layout", () => {
    const layout = makeLayout({
      a: { id: "a", params: { browserId: "a", initialUrl: "https://kept.test" } },
    });
    const result = injectInitialUrls(layout, new Map([["a", "https://incoming.test"]])) as {
      panels: Record<string, { params: { initialUrl: string } }>;
    };
    expect(result.panels.a.params.initialUrl).toBe("https://kept.test");
  });

  it("skips panels with no matching url", () => {
    const layout = makeLayout({
      a: { id: "a", params: { browserId: "a" } },
      b: { id: "b", params: { browserId: "b" } },
    });
    const result = injectInitialUrls(layout, new Map([["a", "https://example.com"]])) as {
      panels: Record<string, { params: Record<string, unknown> }>;
    };
    expect(result.panels.a.params.initialUrl).toBe("https://example.com");
    expect(result.panels.b.params.initialUrl).toBeUndefined();
  });

  it("preserves reference equality when no panel matches", () => {
    // urls has entries, but the keys don't intersect with any panel
    // id — the function should hand the source layout straight back so
    // callers using `===` to detect changes aren't fooled.
    const layout = makeLayout({ a: { id: "a", params: { browserId: "a" } } });
    expect(injectInitialUrls(layout, new Map([["zzz", "https://x.test"]]))).toBe(layout);
  });

  it("preserves reference equality when every match already has initialUrl", () => {
    const layout = makeLayout({
      a: { id: "a", params: { browserId: "a", initialUrl: "https://kept.test" } },
    });
    expect(injectInitialUrls(layout, new Map([["a", "https://incoming.test"]]))).toBe(layout);
  });

  it("skips panels whose params are missing or malformed", () => {
    const layout = makeLayout({
      a: { id: "a" /* no params */ },
      b: { id: "b", params: "broken" },
      c: { id: "c", params: null },
    });
    const result = injectInitialUrls(
      layout,
      new Map([
        ["a", "u"],
        ["b", "u"],
        ["c", "u"],
      ]),
    ) as {
      panels: Record<string, unknown>;
    };
    // Each malformed panel is passed through untouched (same identity).
    const original = layout.panels;
    expect(result.panels.a).toBe(original.a);
    expect(result.panels.b).toBe(original.b);
    expect(result.panels.c).toBe(original.c);
  });
});
