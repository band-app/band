import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";
import {
  entriesUnder,
  playwrightFilter,
  quarantineMode,
  readQuarantine,
} from "../../scripts/ci/flaky-quarantine.mjs";
import { scrubWorkerEnv } from "../../scripts/test-env.mjs";

// Runs in the parent of every spec, so each hub and band-worker a spec starts
// inherits an environment without the identity of the Band worker running the suite.
scrubWorkerEnv();

// Every hub a spec starts fetches the official extension catalog at boot. Point it at a closed
// loopback port so the fetch fails at once and no spec reaches GitHub. The catalog specs pass
// their own stub URL to `startServer`.
process.env.BAND_EXTENSION_CATALOG_URL ??= "http://127.0.0.1:9/index.json";

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

const quarantine = playwrightFilter(
  entriesUnder(readQuarantine(), "apps/web/e2e/"),
  quarantineMode(),
);

export default defineConfig({
  testDir: "./e2e",
  ...quarantine,
  // CI retries a failed spec once. The JSON reporter marks a spec that passed on the retry
  // `flaky`, and scripts/ci/report-flaky.mjs files an issue for it. Local runs never retry.
  retries: process.env.CI ? 1 : 0,
  reporter:
    process.env.CI && process.env.PLAYWRIGHT_JSON_OUTPUT_NAME
      ? [["dot"], ["json"]]
      : process.env.CI
        ? "dot"
        : "list",
  timeout: 30_000,
  // A spec that starts a real band-worker waits for it to say hello. It runs from TypeScript
  // source through tsx, which takes longer than the 5 s default on a cold start. The wait only
  // lasts as long as the worker takes; a failing assertion is the one that pays the full time.
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1",
    // A flake that only fails in CI has to carry its own evidence: the trace and the last
    // screenshot land in test-results/, which ci.yml uploads on failure.
    trace: "retain-on-failure" as const,
    screenshot: "only-on-failure" as const,
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
