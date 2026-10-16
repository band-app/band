/**
 * Calls the keep-awake controller directly with a fake blocker: the saved file
 * sits under a sandboxed HOME. The Electron `powerSaveBlocker` is
 * replaced by a recorder, because the real one needs the Electron runtime; its
 * effect (a PreventUserIdleSystemSleep assertion in `pmset -g assertions`) is
 * checked against a desktop build.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { KeepAwakeController, loadKeepAwake } from "../src/main/services/keep-awake.ts";

function recorder() {
  const active = new Set<number>();
  let next = 1;
  return {
    active,
    start: () => {
      const id = next++;
      active.add(id);
      return id;
    },
    stop: (id: number) => {
      active.delete(id);
    },
  };
}

describe("keep awake", () => {
  let sandboxHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "band-desktop-keep-awake-"));
    process.env.HOME = sandboxHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(sandboxHome, { recursive: true, force: true });
  });

  test("is off with no saved file", () => {
    const blocker = recorder();
    const controller = new KeepAwakeController(blocker);
    controller.restore();
    assert.equal(controller.isEnabled(), false);
    assert.equal(blocker.active.size, 0);
  });

  test("on starts one blocker, off releases it", () => {
    const blocker = recorder();
    const controller = new KeepAwakeController(blocker);
    assert.equal(controller.set(true), true);
    assert.equal(controller.set(true), true);
    assert.equal(blocker.active.size, 1);
    assert.equal(controller.set(false), false);
    assert.equal(blocker.active.size, 0);
  });

  test("a new controller restores the saved state", () => {
    new KeepAwakeController(recorder()).set(true);
    assert.equal(loadKeepAwake(), true);
    const blocker = recorder();
    const next = new KeepAwakeController(blocker);
    next.restore();
    assert.equal(next.isEnabled(), true);
    assert.equal(blocker.active.size, 1);
    next.set(false);
    assert.equal(loadKeepAwake(), false);
  });

  test("a corrupt or non-boolean saved file leaves it off", async () => {
    await mkdir(join(sandboxHome, ".band"), { recursive: true });
    const file = join(sandboxHome, ".band", "desktop-keep-awake.json");
    for (const content of ["{not json", '{"enabled":"yes"}']) {
      await writeFile(file, content);
      const blocker = recorder();
      const controller = new KeepAwakeController(blocker);
      controller.restore();
      assert.equal(controller.isEnabled(), false);
      assert.equal(blocker.active.size, 0);
    }
  });
});
