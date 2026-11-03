import { defineConfig } from "@playwright/test";
import { scrubWorkerEnv } from "../../scripts/test-env.mjs";

// The app and the hub it starts must not inherit the identity of the Band worker running the suite.
scrubWorkerEnv();

// Drives the real Electron desktop app (apps/desktop) with Playwright's
// `_electron`. Separate from `playwright.config.ts`, whose projects run the
// web build in plain Chromium. Needs `pnpm build` (hub, UI) and
// `pnpm --filter @band-app/desktop build` first.
export default defineConfig({
  testDir: "./e2e-desktop",
  // Lists the real Band profile before and after the run and fails if it changed.
  globalSetup: "./e2e-desktop/global-setup.ts",
  globalTeardown: "./e2e-desktop/global-teardown.ts",
  timeout: 120_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: { trace: "retain-on-failure" },
});
