/**
 * `src/main/services/mod-window.ts`: the window options of a client mod and the optional native
 * addon's loading, with plain objects in place of a `BrowserWindow`.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  parseModWindow,
  readModWindowOptions,
  resolveWindowChrome,
  TOOLBAR_STYLE,
  vibrancyFor,
} from "../src/main/services/mod-window.ts";
import { loadNative, nativeAddonPath } from "../src/main/services/native.ts";
import { applyPowerToWindow, setWindowVibrancy } from "../src/main/services/window-power.ts";

function install(dir: string, id: string, mod: unknown): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(
    join(dir, id, "band-extension.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", extensionApi: 1, contributes: { mod } }),
  );
}

function fakeWindow() {
  const vibrancy: Array<string | null> = [];
  return {
    vibrancy,
    win: {
      setVibrancy: (v: string | null) => vibrancy.push(v),
      isDestroyed: () => false,
    },
  };
}

describe("window options of a mod", () => {
  test("without a mod the defaults stay", () => {
    const chrome = resolveWindowChrome({});
    assert.equal(chrome.material, "sidebar");
    assert.equal(chrome.titleBarStyle, "hiddenInset");
    assert.equal(chrome.toolbar, "none");
    assert.deepEqual(chrome.trafficLightPosition, { x: 13, y: 10 });
    assert.equal(vibrancyFor(chrome.material), "sidebar");
  });

  test("a mod's values are read from the extensions folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "band-mod-window-"));
    install(dir, "macos-look", {
      window: {
        material: "under-window",
        titleBarStyle: "hidden",
        toolbar: "unified",
        trafficLightPosition: { x: 20, y: 18 },
      },
    });
    install(dir, "no-mod", undefined);
    const opts = readModWindowOptions(dir, {});
    assert.deepEqual(opts, {
      material: "under-window",
      titleBarStyle: "hidden",
      toolbar: "unified",
      trafficLightPosition: { x: 20, y: 18 },
    });
    assert.deepEqual(readModWindowOptions(dir, { BAND_MODS: "off" }), {});
  });

  test("a bad value is dropped", () => {
    assert.deepEqual(
      parseModWindow({ material: "plastic", titleBarStyle: 3, toolbar: "huge" }),
      {},
    );
  });

  test("none removes vibrancy and any other material is its own vibrancy", () => {
    assert.equal(vibrancyFor("none"), null);
    assert.equal(vibrancyFor("sidebar"), "sidebar");
    assert.equal(vibrancyFor("under-window"), "under-window");
  });

  test("toolbar options map to NSWindowToolbarStyle values", () => {
    assert.deepEqual(TOOLBAR_STYLE, { unified: 3, compact: 4 });
  });
});

describe("the optional native addon", () => {
  test("a missing, forced-off or non-macOS addon loads as null", () => {
    assert.equal(loadNative({ BAND_FORCE_NATIVE_LOAD_FAIL: "1" }), null);
    assert.equal(loadNative({}, join(tmpdir(), "does-not-exist.node")), null);
    assert.equal(loadNative({}, "/x.node", "linux"), null);
  });

  test("the addon path is unpacked from the asar in a packaged app", () => {
    const path = nativeAddonPath(
      "/Applications/Band.app/Contents/Resources/app.asar/dist/main/main/services",
    );
    assert.equal(
      path,
      "/Applications/Band.app/Contents/Resources/app.asar.unpacked/native/build/band-native.node",
    );
  });
});

describe("power with a mod material", () => {
  test("AC restores the window's own material and battery removes it", () => {
    const { win, vibrancy } = fakeWindow();
    setWindowVibrancy(win, "under-window");
    applyPowerToWindow(win, true, "darwin");
    applyPowerToWindow(win, false, "darwin");
    assert.deepEqual(vibrancy, [null, "under-window"]);
  });
});
