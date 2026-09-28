/**
 * Integration test for the saved main-window state.
 *
 * Real filesystem, sandboxed via HOME. Covers the round trip through
 * `~/.band/desktop-window.json`, unreadable files, and which saved bounds
 * still land on a connected display. Applying the state to a real
 * `BrowserWindow` (`window.ts`) needs the Electron runtime and is checked in
 * the desktop build.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  fitToDisplays,
  loadWindowState,
  saveWindowState,
} from "../src/main/services/window-state.ts";

describe("window state", () => {
  let sandboxHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "band-desktop-window-state-"));
    process.env.HOME = sandboxHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(sandboxHome, { recursive: true, force: true });
  });

  test("nothing saved on the first launch", () => {
    assert.equal(loadWindowState(), null);
  });

  test("a saved state reads back, creating ~/.band if needed", () => {
    const state = {
      bounds: { x: 120, y: 80, width: 1400, height: 900 },
      maximized: true,
      fullScreen: false,
    };
    saveWindowState(state);
    assert.deepEqual(loadWindowState(), state);
  });

  test("a malformed or incomplete file counts as nothing saved", async () => {
    await mkdir(join(sandboxHome, ".band"), { recursive: true });
    const file = join(sandboxHome, ".band", "desktop-window.json");
    await writeFile(file, "{not json");
    assert.equal(loadWindowState(), null);
    await writeFile(file, JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 700 } }));
    assert.equal(loadWindowState(), null);
  });

  const laptop = { x: 0, y: 25, width: 1512, height: 944 };
  const external = { x: 1512, y: 0, width: 2560, height: 1415 };

  test("bounds on a connected display are kept", () => {
    const bounds = { x: 1700, y: 100, width: 1600, height: 1000 };
    assert.deepEqual(fitToDisplays(bounds, [laptop, external]), bounds);
  });

  test("bounds on an unplugged display are dropped", () => {
    assert.equal(fitToDisplays({ x: 1700, y: 100, width: 1600, height: 1000 }, [laptop]), null);
  });

  test("bounds partly off a display are moved and shrunk onto it", () => {
    assert.deepEqual(fitToDisplays({ x: 1200, y: 25, width: 2000, height: 1200 }, [laptop]), {
      x: 0,
      y: 25,
      width: 1512,
      height: 944,
    });
  });
});
