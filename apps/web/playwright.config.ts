import { defineConfig, devices } from "@playwright/test";

// Specs that run in WebKit with an iPhone profile instead of Chromium.
const WEBKIT_IPHONE_SPECS = /mobile-document-scroll\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testIgnore: WEBKIT_IPHONE_SPECS },
    {
      name: "webkit-iphone",
      use: { ...devices["iPhone 15"], browserName: "webkit" },
      testMatch: WEBKIT_IPHONE_SPECS,
    },
  ],
});
