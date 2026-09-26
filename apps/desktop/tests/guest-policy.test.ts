/**
 * Pure-function tests for the `<webview>` guest gate (`guest-policy.ts`):
 * which attaches `will-attach-webview` admits, what it overwrites on the
 * ones it admits, and which later navigations the guest may start. No
 * Electron deps, so the test runs under `node:test` like the other desktop
 * unit tests.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  admitWebviewAttach,
  BROWSER_PARTITION,
  hardenGuestWebPreferences,
  isAllowedGuestNavigation,
} from "../src/browser/guest-policy.ts";

describe("admitWebviewAttach", () => {
  test("admits http(s) and about:blank in the browser partition", () => {
    for (const src of ["https://example.com/", "http://localhost:3000/x", "about:blank"]) {
      assert.equal(admitWebviewAttach({ src, partition: BROWSER_PARTITION }), true, src);
    }
  });

  test("admits browser profile partitions", () => {
    for (const partition of [
      "persist:band-browser-profile-work",
      "persist:band-browser-profile-a_B-9",
      `persist:band-browser-profile-${"a".repeat(64)}`,
    ]) {
      assert.equal(admitWebviewAttach({ src: "https://example.com/", partition }), true, partition);
    }
  });

  test("refuses any other partition", () => {
    for (const partition of [
      "",
      "persist:other",
      "band-browser",
      "persist:band-browser-x",
      "persist:band-browser-profile-",
      "persist:band-browser-profile-../../etc",
      `persist:band-browser-profile-${"a".repeat(65)}`,
    ]) {
      assert.equal(
        admitWebviewAttach({ src: "https://example.com/", partition }),
        false,
        partition,
      );
    }
  });

  test("refuses sources outside http(s) and about:blank", () => {
    for (const src of [
      "",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "chrome://settings",
      "about:srcdoc",
      "not a url",
    ]) {
      assert.equal(admitWebviewAttach({ src, partition: BROWSER_PARTITION }), false, src);
    }
  });
});

describe("hardenGuestWebPreferences", () => {
  test("overwrites what the markup asked for and pins the guest preload", () => {
    const webPreferences: Record<string, unknown> = {
      partition: BROWSER_PARTITION,
      preload: "/evil/preload.js",
      preloadURL: "file:///evil/preload.js",
      additionalArguments: ["--band-host"],
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      enableBlinkFeatures: "SomeFeature",
      webviewTag: true,
    };
    const params: Record<string, unknown> = { preload: "file:///evil/preload.js", src: "x" };

    hardenGuestWebPreferences(webPreferences, params, "/app/guest.cjs");

    assert.deepEqual(webPreferences, {
      partition: BROWSER_PARTITION,
      preload: "/app/guest.cjs",
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableBlinkFeatures: "",
      disableBlinkFeatures: "",
      webviewTag: false,
    });
    assert.deepEqual(params, { src: "x" });
  });
  test("keeps a browser profile partition", () => {
    const webPreferences: Record<string, unknown> = {
      partition: "persist:band-browser-profile-work",
      nodeIntegration: true,
    };
    hardenGuestWebPreferences(webPreferences, {}, "/app/guest.cjs");
    assert.equal(webPreferences.partition, "persist:band-browser-profile-work");
    assert.equal(webPreferences.nodeIntegration, false);
  });
});

describe("isAllowedGuestNavigation", () => {
  test("allows ordinary browsing and the error-page action scheme", () => {
    for (const url of [
      "https://example.com/a",
      "http://127.0.0.1:8080/",
      "about:blank",
      "blob:https://example.com/0f8e",
      "band-action://cert-proceed?host=a&fp=b",
      "band-action:load-retry",
    ]) {
      assert.equal(isAllowedGuestNavigation(url), true, url);
    }
  });

  test("blocks the filesystem, opaque blobs and other schemes", () => {
    for (const url of [
      "file:///Users/me/.ssh/id_rsa",
      "blob:null/1234",
      "chrome://gpu",
      "slack://open",
      "javascript:void(0)",
      "",
    ]) {
      assert.equal(isAllowedGuestNavigation(url), false, url);
    }
  });
});
