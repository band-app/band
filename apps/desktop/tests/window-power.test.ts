/**
 * `applyPowerToWindow` (`src/main/services/window-power.ts`) with a plain object in place of a
 * `BrowserWindow`, which needs the Electron runtime. It covers the vibrancy switch on AC and battery.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { applyPowerToWindow } from "../src/main/services/window-power.ts";

function fakeWindow(destroyed = false) {
  const calls: Array<"sidebar" | null> = [];
  return {
    calls,
    win: {
      setVibrancy: (type: "sidebar" | null) => calls.push(type),
      isDestroyed: () => destroyed,
    },
  };
}

describe("applyPowerToWindow", () => {
  test("removes the vibrancy layer on battery and restores it on AC", () => {
    const { win, calls } = fakeWindow();
    applyPowerToWindow(win, true, "darwin");
    applyPowerToWindow(win, false, "darwin");
    assert.deepEqual(calls, [null, "sidebar"]);
  });

  test("does nothing off macOS", () => {
    const { win, calls } = fakeWindow();
    applyPowerToWindow(win, true, "linux");
    assert.deepEqual(calls, []);
  });

  test("does nothing for a destroyed window", () => {
    const { win, calls } = fakeWindow(true);
    applyPowerToWindow(win, true, "darwin");
    assert.deepEqual(calls, []);
  });
});
