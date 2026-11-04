import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import {
  entriesUnder,
  quarantineMode,
  readQuarantine,
  vitestFilter,
} from "../../scripts/ci/flaky-quarantine.mjs";

const quarantine = vitestFilter(entriesUnder(readQuarantine(), "apps/web/"), quarantineMode());

export default defineConfig({
  resolve: {
    alias: {
      // Mirror vite.config.ts so tests can use the `@/...` shorthand. Vitest
      // doesn't pick up plugin-level aliases from vite.config.ts automatically.
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // CI retries a failed test once and reports a pass on the retry as flaky.
    retry: process.env.CI ? 1 : 0,
    reporters: process.env.CI
      ? ["default", resolve(import.meta.dirname, "../../scripts/ci/vitest-flaky-reporter.mjs")]
      : ["default"],
    ...quarantine,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: quarantine.include ?? ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
