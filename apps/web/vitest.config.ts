import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    // sync-state.test.ts pulls src/lib/db/connection.ts which imports
    // bun:sqlite at module load. Vitest runs under Node and cannot resolve
    // bun:sqlite, so the file fails to import. Re-enable when the suite
    // migrates to `bun test`.
    exclude: ["tests/sync-state.test.ts", "**/node_modules/**"],
  },
});
