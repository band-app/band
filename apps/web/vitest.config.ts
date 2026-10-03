import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror vite.config.ts so tests can use the `@/...` shorthand. Vitest
      // doesn't pick up plugin-level aliases from vite.config.ts automatically.
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
