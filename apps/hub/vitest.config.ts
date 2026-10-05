import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Tests that run pnpm under a temp HOME (dev-server, plain-repos) would make
// corepack look for pnpm in an empty cache and download it. Point it at the
// cache of the real HOME, read here before any test changes HOME, and never
// prompt, so nothing needs the network after `pnpm install`.
const corepackHome =
  process.env.COREPACK_HOME ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "node", "corepack");

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
    globalSetup: ["tests/global-setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Every server a test boots inherits this, so coding agents (including
    // the boot-time model probe) run as the scripted ACP stub rather than
    // the real Claude Code / Codex adapters (issue #648).
    env: {
      BAND_TEST_ACP_AGENT: resolve(import.meta.dirname, "tests/fixtures/acp-stub-agent.mjs"),
      COREPACK_HOME: corepackHome,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    },
    exclude: [
      "**/node_modules/**",
      // Needs the worker image, which only the CI `docker` job builds and runs it from.
      ...(process.env.BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB ? ["tests/runner-docker.test.ts"] : []),
    ],
  },
});
