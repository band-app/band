/** `symbols.ts` (the `band-symbol://` protocol) and `system-colors.ts` (`--mac-*` CSS variables), with fakes for the addon and Electron. */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { symbolReply, symbolResponse } from "../src/main/services/symbols.ts";
import {
  type CssTarget,
  systemColorsCss,
  watchSystemColors,
} from "../src/main/services/system-colors.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("band-symbol protocol", () => {
  test("renders a symbol with clamped parameters and caches it", () => {
    const calls: unknown[][] = [];
    const native = {
      symbolPNG: (...args: unknown[]) => {
        calls.push(args);
        return PNG;
      },
    } as never;
    const url = "band-symbol://sidebar.left?pt=13&w=0.23&s=4";
    const a = symbolReply(url, native);
    const b = symbolReply(url, native);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, PNG);
    assert.equal(b.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["sidebar.left", 13, 0.23, 4]);
    symbolReply("band-symbol://gearshape?pt=9999&w=9&s=99", native);
    assert.deepEqual(calls[1], ["gearshape", 96, 0.8, 6]);
  });

  test("refuses a bad name, 404s without the addon or an unknown symbol", () => {
    const native = { symbolPNG: () => null } as never;
    assert.equal(symbolReply("band-symbol://../etc/passwd", native).status, 400);
    assert.equal(symbolReply("band-symbol://Has%20Space", native).status, 400);
    assert.equal(symbolReply("band-symbol://folder", null).status, 404);
    assert.equal(symbolReply("band-symbol://no.such.symbol", native).status, 404);
    assert.equal(symbolReply("not a url", native).status, 400);
  });

  test("the response is a cacheable PNG that any page origin may read", async () => {
    const native = { symbolPNG: () => PNG } as never;
    const res = symbolResponse("band-symbol://folder", native);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });
});

describe("system colors", () => {
  const colors: Record<string, string> = {
    label: "#FFFFFFD8",
    "secondary-label": "#FFFFFF8C",
    separator: "#FFFFFF19",
    "selected-content-background": "#0059D1FF",
    link: "not a color",
  };

  test("maps AppKit colors to variables and drops what is not a hex color", () => {
    const css = systemColorsCss((name) => {
      if (name === "window-background") throw new Error("Unknown color");
      return colors[name] ?? "";
    }, "007AFFFF");
    assert.match(css, /--mac-label:#FFFFFFD8;/);
    assert.match(css, /--mac-selected-content:#0059D1FF;/);
    assert.match(css, /--mac-accent:#007AFF;/);
    assert.ok(!css.includes("--mac-link"));
    assert.ok(!css.includes("--mac-window-background"));
    assert.ok(css.startsWith(":root{") && css.endsWith("}"));
    assert.ok(!css.includes("--mac-symbols"));
    assert.match(
      systemColorsCss(() => "", "007AFFFF", { symbols: true }),
      /--mac-symbols:1;/,
    );
  });

  test("inserts on load and replaces the css when the appearance changes", async () => {
    const inserted: string[] = [];
    const removed: string[] = [];
    let loadHandler = () => {};
    const target: CssTarget = {
      insertCSS: async (css) => {
        inserted.push(css);
        return `key-${inserted.length}`;
      },
      removeInsertedCSS: async (key) => {
        removed.push(key);
      },
      isDestroyed: () => false,
      on: (_event, fn) => {
        loadHandler = fn;
      },
    };
    let changeHandler = () => {};
    let label = "#FFFFFFD8";
    const off = watchSystemColors(target, {
      getColor: (name) => (name === "label" ? label : "#000000"),
      getAccentColor: () => "007AFFFF",
      onChange: (fn) => {
        changeHandler = fn;
        return () => {};
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(inserted.length, 1);
    label = "#000000D8";
    changeHandler();
    await new Promise((r) => setImmediate(r));
    assert.equal(inserted.length, 2);
    assert.match(inserted[1], /--mac-label:#000000D8;/);
    assert.deepEqual(removed, ["key-1"]);
    loadHandler();
    await new Promise((r) => setImmediate(r));
    assert.equal(inserted.length, 3);
    off();
  });

  test("reads the colors again after a change, because the appearance settles late", async () => {
    const inserted: string[] = [];
    const target: CssTarget = {
      insertCSS: async (css) => {
        inserted.push(css);
        return `key-${inserted.length}`;
      },
      removeInsertedCSS: async () => {},
      isDestroyed: () => false,
      on: () => {},
    };
    let changeHandler = () => {};
    let label = "#FFFFFFD8";
    const off = watchSystemColors(target, {
      getColor: (name) => (name === "label" ? label : "#000000"),
      getAccentColor: () => "007AFFFF",
      onChange: (fn) => {
        changeHandler = fn;
        return () => {};
      },
    });
    await new Promise((r) => setImmediate(r));
    // The event fires while getColor still answers with the old appearance.
    changeHandler();
    await new Promise((r) => setTimeout(r, 30));
    label = "#000000D8";
    await new Promise((r) => setTimeout(r, 600));
    assert.match(inserted.at(-1) ?? "", /--mac-label:#000000D8;/);
    off();
  });
});
