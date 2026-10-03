import { defineConfig } from "@playwright/test";

// Drives the real Electron desktop app (apps/desktop) with Playwright's
// `_electron`. Separate from `playwright.config.ts`, whose projects run the
// web build in plain Chromium. Needs `pnpm build` (hub, UI) and
// `pnpm --filter @band-app/desktop build` first.
export default defineConfig({
  testDir: "./e2e-desktop",
  timeout: 120_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: { trace: "retain-on-failure" },
});
