/**
 * Pure-function tests for `decideWindowOpenAction` (the routing rule
 * used by `BrowserViewManager`'s `setWindowOpenHandler` to convert
 * page-initiated new-window requests into Band browser tabs — issue
 * #488). No Electron deps, so the test runs under `node:test` like
 * the other desktop unit tests.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { decideWindowOpenAction } from "../src/browser/window-open.ts";

describe("decideWindowOpenAction", () => {
  test("http URL → open-in-band", () => {
    const result = decideWindowOpenAction("http://example.com/page");
    assert.deepEqual(result, { kind: "open-in-band", url: "http://example.com/page" });
  });

  test("https URL → open-in-band", () => {
    const result = decideWindowOpenAction("https://example.com/path?q=1");
    assert.deepEqual(result, { kind: "open-in-band", url: "https://example.com/path?q=1" });
  });

  test("trims surrounding whitespace before deciding", () => {
    const result = decideWindowOpenAction("   https://example.com/  ");
    assert.deepEqual(result, { kind: "open-in-band", url: "https://example.com/" });
  });

  test("empty string → ignore (empty-url)", () => {
    const result = decideWindowOpenAction("");
    assert.deepEqual(result, { kind: "ignore", reason: "empty-url" });
  });

  test("whitespace-only → ignore (empty-url)", () => {
    const result = decideWindowOpenAction("   \t\n");
    assert.deepEqual(result, { kind: "ignore", reason: "empty-url" });
  });

  test("about:blank → ignore (about-blank)", () => {
    // Common popup pattern: `const w = window.open("about:blank");
    // w.document.write(...)`. We deny the OS window and skip making
    // a Band tab — the page can't script into a WebContentsView we
    // never handed back, so a fresh tab would just be litter.
    const result = decideWindowOpenAction("about:blank");
    assert.deepEqual(result, { kind: "ignore", reason: "about-blank" });
  });

  test("ABOUT:BLANK (mixed case) → ignore (about-blank)", () => {
    const result = decideWindowOpenAction("ABOUT:BLANK");
    assert.deepEqual(result, { kind: "ignore", reason: "about-blank" });
  });

  test("javascript: URL → ignore (javascript-scheme)", () => {
    const result = decideWindowOpenAction("javascript:void(0)");
    assert.deepEqual(result, { kind: "ignore", reason: "javascript-scheme" });
  });

  test("JavaScript: (mixed case) → ignore (javascript-scheme)", () => {
    const result = decideWindowOpenAction("JavaScript:alert(1)");
    assert.deepEqual(result, { kind: "ignore", reason: "javascript-scheme" });
  });

  test("data: URL → ignore (unsupported-scheme)", () => {
    // data: would look broken in a Band tab (no address-bar host
    // affordance, no reload semantics). Deny the OS window and skip
    // the tab — same outcome as Chrome's popup blocker.
    const result = decideWindowOpenAction("data:text/html,<p>hi</p>");
    assert.deepEqual(result, { kind: "ignore", reason: "unsupported-scheme" });
  });

  test("file: URL → ignore (unsupported-scheme)", () => {
    const result = decideWindowOpenAction("file:///etc/passwd");
    assert.deepEqual(result, { kind: "ignore", reason: "unsupported-scheme" });
  });

  test("chrome: URL → ignore (unsupported-scheme)", () => {
    const result = decideWindowOpenAction("chrome://settings");
    assert.deepEqual(result, { kind: "ignore", reason: "unsupported-scheme" });
  });

  test("custom app: scheme → ignore (unsupported-scheme)", () => {
    // Common-pattern URL Apple Music etc. use to deep-link out of a
    // tab — we don't want to surface those as Band tabs.
    const result = decideWindowOpenAction("itmss://music.apple.com/album/123");
    assert.deepEqual(result, { kind: "ignore", reason: "unsupported-scheme" });
  });
});
