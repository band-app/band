import { resolve } from "node:path";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror vite.config.ts so tests can use the `@/...` shorthand. Vitest
      // doesn't pick up plugin-level aliases from vite.config.ts automatically.
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
