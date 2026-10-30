import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";
import { scrubWorkerEnv } from "../../scripts/test-env.mjs";

// Runs in the parent of every spec, so each hub and band-worker a spec starts
// inherits an environment without the identity of the Band worker running the suite.
scrubWorkerEnv();

// Without WebKit the iPhone project would fail every spec. Skip it locally and
// say how to install it; CI installs it, so it always runs there.
const hasWebkit = existsSync(webkit.executablePath());
if (!hasWebkit) {
  console.warn(
    "WebKit is not installed, so the webkit-iphone project is skipped. Install it with: pnpm --filter @band-app/web exec playwright install webkit",
  );
}

// Specs that run in WebKit with an iPhone profile instead of Chromium.
const WEBKIT_IPHONE_SPECS = /mobile-document-scroll\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // A spec that starts a real band-worker waits for it to say hello. It runs from TypeScript
  // source through tsx, which takes longer than the 5 s default on a cold start. The wait only
  // lasts as long as the worker takes; a failing assertion is the one that pays the full time.
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testIgnore: WEBKIT_IPHONE_SPECS },
    ...(hasWebkit
      ? [
          {
            name: "webkit-iphone",
            use: { ...devices["iPhone 15"], browserName: "webkit" as const },
            testMatch: WEBKIT_IPHONE_SPECS,
          },
        ]
      : []),
  ],
});
