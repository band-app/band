import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
