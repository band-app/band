/**
 * Pure-function tests for the generic load-error helpers
 * (`apps/desktop/src/browser/load-error.ts`, issue #444 follow-up).
 *
 * The cert-error interstitial covers TLS validation failures
 * (`certificate-error`). Everything else lands in this pipeline via
 * `did-fail-load`: DNS, refused, timeout, etc.
 *
 * Invariants enforced here:
 *
 *   - Subframe failures are filtered out (an iframe failing must
 *     not blank the host page).
 *   - `ERR_ABORTED` is filtered out (a canceled navigation isn't
 *     an error from the user's POV).
 *   - Cert errors (-200 to -299) are filtered out so the cert
 *     pipeline owns them — no double-rendering of two overlays.
 *   - Common Chromium codes map to specific Chrome-style headlines
 *     (DNS, refused, timeout, …).
 *   - Unknown codes fall back to a generic page rather than
 *     crashing.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  buildLoadErrorPayload,
  describeLoadError,
  isMainFrameFailure,
} from "../src/browser/load-error.ts";

describe("isMainFrameFailure", () => {
  test("non-main-frame failures are filtered out", () => {
    assert.equal(isMainFrameFailure({ errorCode: -105, isMainFrame: false }), false);
  });

  test("ERR_ABORTED (-3) on the main frame is filtered out", () => {
    assert.equal(isMainFrameFailure({ errorCode: -3, isMainFrame: true }), false);
  });

  test("cert errors (-200 to -299) on the main frame are filtered out", () => {
    // Boundary values
    assert.equal(isMainFrameFailure({ errorCode: -200, isMainFrame: true }), false);
    assert.equal(isMainFrameFailure({ errorCode: -201, isMainFrame: true }), false);
    assert.equal(isMainFrameFailure({ errorCode: -202, isMainFrame: true }), false);
    assert.equal(isMainFrameFailure({ errorCode: -299, isMainFrame: true }), false);
  });

  test("DNS failure (-105) on the main frame is surfaced", () => {
    assert.equal(isMainFrameFailure({ errorCode: -105, isMainFrame: true }), true);
  });

  test("connection refused (-102) on the main frame is surfaced", () => {
    assert.equal(isMainFrameFailure({ errorCode: -102, isMainFrame: true }), true);
  });

  test("timeout (-118) on the main frame is surfaced", () => {
    assert.equal(isMainFrameFailure({ errorCode: -118, isMainFrame: true }), true);
  });

  test("unknown codes outside the cert range are still surfaced", () => {
    assert.equal(isMainFrameFailure({ errorCode: -9999, isMainFrame: true }), true);
  });
});

describe("describeLoadError", () => {
  test("ERR_NAME_NOT_RESOLVED (-105) — DNS", () => {
    const d = describeLoadError(-105);
    assert.equal(d.name, "ERR_NAME_NOT_RESOLVED");
    assert.match(d.headline, /can't be reached/i);
    assert.match(d.description, /DNS/i);
  });

  test("ERR_INTERNET_DISCONNECTED (-106) — offline", () => {
    const d = describeLoadError(-106);
    assert.equal(d.name, "ERR_INTERNET_DISCONNECTED");
    assert.match(d.headline, /no internet/i);
  });

  test("ERR_CONNECTION_REFUSED (-102)", () => {
    const d = describeLoadError(-102);
    assert.equal(d.name, "ERR_CONNECTION_REFUSED");
    assert.match(d.description, /refused/i);
  });

  test("ERR_CONNECTION_TIMED_OUT (-118)", () => {
    const d = describeLoadError(-118);
    assert.equal(d.name, "ERR_CONNECTION_TIMED_OUT");
    assert.match(d.description, /timed out|too slow/i);
  });

  test("ERR_BLOCKED_BY_CLIENT (-20)", () => {
    const d = describeLoadError(-20);
    assert.equal(d.name, "ERR_BLOCKED_BY_CLIENT");
    assert.match(d.headline, /blocked/i);
  });

  test("unknown codes get a generic fallback (no crash)", () => {
    const d = describeLoadError(-9999);
    assert.equal(d.name, "ERR_-9999");
    assert.match(d.headline, /can't be reached/i);
    assert.match(d.description, /unexpected/i);
  });
});

describe("buildLoadErrorPayload", () => {
  test("plumbs every field into the snake_case payload", () => {
    const payload = buildLoadErrorPayload({
      key: "tab-99",
      url: "https://nonexistent.example/foo",
      errorCode: -105,
    });
    assert.equal(payload.browser_id, "tab-99");
    assert.equal(payload.workspace_id, "tab-99");
    assert.equal(payload.url, "https://nonexistent.example/foo");
    assert.equal(payload.error_code, -105);
    assert.equal(payload.error_name, "ERR_NAME_NOT_RESOLVED");
    assert.match(payload.headline, /can't be reached/i);
    assert.match(payload.description, /DNS/i);
  });

  test("unknown code still produces a usable payload (no crash)", () => {
    const payload = buildLoadErrorPayload({
      key: "tab-1",
      url: "https://example.com",
      errorCode: -42,
    });
    assert.equal(payload.error_code, -42);
    assert.equal(payload.error_name, "ERR_-42");
    assert.match(payload.headline, /can't be reached/i);
  });
});
