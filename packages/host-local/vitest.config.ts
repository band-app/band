import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    // The host contract starts a coding agent as the scripted ACP stub the
    // hub's integration tests use, instead of the real adapters.
    env: {
      BAND_TEST_ACP_AGENT: resolve(
        import.meta.dirname,
        "../../apps/hub/tests/fixtures/acp-stub-agent.mjs",
      ),
    },
    exclude: ["**/node_modules/**"],
  },
});
