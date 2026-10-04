import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    // Every server a test boots inherits this, so coding agents (including
    // the boot-time model probe) run as the scripted ACP stub rather than
    // the real Claude Code / Codex adapters (issue #648).
    env: {
      BAND_TEST_ACP_AGENT: resolve(import.meta.dirname, "tests/fixtures/acp-stub-agent.mjs"),
    },
    exclude: [
      "**/node_modules/**",
      // Needs the worker image, which only the CI `docker` job builds and runs it from.
      ...(process.env.BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB ? ["tests/runner-docker.test.ts"] : []),
    ],
  },
});
