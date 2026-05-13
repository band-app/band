/**
 * Pure-function tests for `splitTabBounds` (the geometry used to dock
 * Chromium DevTools at the bottom of a browser tab). No Electron deps,
 * so the test runs under `node:test` like the other desktop tests.
 *
 * The invariants enforced here exist because the DevTools dock has to
 * cope with very short windows — early versions of this code clamped
 * `devHeight` to a minimum without also capping it, causing
 * `page.height + dev.height` to exceed the outer bounds.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { splitTabBounds } from "../src/browser/layout.ts";

const OPTIONS = { splitRatio: 0.4, devMinHeight: 160, pageMinHeight: 40 };

describe("splitTabBounds", () => {
  test("comfortable window: dev = round(height * splitRatio)", () => {
    const { page, dev } = splitTabBounds({ x: 10, y: 20, width: 800, height: 1000 }, OPTIONS);
    assert.equal(dev.height, 400);
    assert.equal(page.height, 600);
    assert.equal(page.x, 10);
    assert.equal(page.y, 20);
    assert.equal(page.width, 800);
    assert.equal(dev.x, 10);
    assert.equal(dev.y, 620);
    assert.equal(dev.width, 800);
  });

  test("medium window: split honours dev min-height when ratio would go below it", () => {
    // 350 * 0.4 = 140 < devMinHeight (160) → bumped to 160.
    const { page, dev } = splitTabBounds({ x: 0, y: 0, width: 600, height: 350 }, OPTIONS);
    assert.equal(dev.height, 160);
    assert.equal(page.height, 190);
  });

  test("short window: page+dev still sum to bounds.height (no overflow)", () => {
    // 180 < devMinHeight + pageMinHeight = 200; the naive clamp would
    // overflow.  Dev gets `height - pageMinHeight = 140`, page gets 40.
    const { page, dev } = splitTabBounds({ x: 0, y: 0, width: 600, height: 180 }, OPTIONS);
    assert.equal(page.height + dev.height, 180);
    assert.equal(page.height, 40);
    assert.equal(dev.height, 140);
  });

  test("very short window (< pageMinHeight): dev sacrificed, page = bounds.height", () => {
    const { page, dev } = splitTabBounds({ x: 0, y: 0, width: 600, height: 20 }, OPTIONS);
    assert.equal(page.height, 20);
    assert.equal(dev.height, 0);
    assert.equal(page.height + dev.height, 20);
  });

  test("zero-height bounds: both pieces collapse to 0", () => {
    const { page, dev } = splitTabBounds({ x: 0, y: 0, width: 600, height: 0 }, OPTIONS);
    assert.equal(page.height, 0);
    assert.equal(dev.height, 0);
  });

  test("invariant: page and dev are vertically adjacent (dev.y = page.y + page.height)", () => {
    const samples = [50, 180, 240, 600, 1000, 4000];
    for (const height of samples) {
      const { page, dev } = splitTabBounds({ x: 17, y: 23, width: 800, height }, OPTIONS);
      assert.equal(dev.y, page.y + page.height, `mismatch at height=${height}`);
      assert.equal(page.height + dev.height, height, `sum mismatch at height=${height}`);
      assert.equal(page.x, dev.x);
      assert.equal(page.width, dev.width);
    }
  });
});
