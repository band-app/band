import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import {
  entriesUnder,
  quarantineMode,
  readQuarantine,
  vitestFilter,
} from "../../scripts/ci/flaky-quarantine.mjs";
import { scrubWorkerEnv } from "../../scripts/test-env.mjs";

// Runs in the parent of every test process, so each server and worker a test
// starts inherits an environment without the Band worker's identity.
scrubWorkerEnv();

// Every hub a test starts fetches the official extension catalog at boot. Point it at a closed
// loopback port so the fetch fails at once and no test hub reaches GitHub. The catalog tests
// pass their own stub URL to `startServer`.
process.env.BAND_EXTENSION_CATALOG_URL ??= "http://127.0.0.1:9/index.json";

// Tests that run pnpm under a temp HOME (dev-server, plain-repos) would make
// corepack look for pnpm in an empty cache and download it. Point it at the
// cache of the real HOME, read here before any test changes HOME, and never
// prompt, so nothing needs the network after `pnpm install`.
const corepackHome =
  process.env.COREPACK_HOME ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "node", "corepack");

// In remote-loopback mode only the files in tests/loopback-files.txt run: the ones whose
// behaviour depends on where the worktree lives. `scripts/check-loopback-files.sh` keeps the
// list honest (every file that imports helpers/test-host must be in it).
const loopbackOnly = process.env.BAND_TEST_HOST === "remote-loopback";
const loopbackFiles = loopbackOnly
  ? readFileSync(resolve(import.meta.dirname, "tests/loopback-files.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((name) => `tests/${name}`)
  : [];
const quarantine = vitestFilter(entriesUnder(readQuarantine(), "apps/hub/"), quarantineMode());

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // CI retries a failed test once and reports a pass on the retry as flaky
    // (scripts/ci/vitest-flaky-reporter.mjs). Local runs and the flake guard never retry.
    retry: process.env.CI ? 1 : 0,
    reporters: process.env.CI
      ? ["default", resolve(import.meta.dirname, "../../scripts/ci/vitest-flaky-reporter.mjs")]
      : ["default"],
    ...quarantine,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Files run in parallel in forked processes. Every server, worker and daemon a test starts
    // uses a random port and its own temp HOME, so files do not share state. BAND_TEST_WORKERS
    // overrides the count; 3 suits the 4-core CI runners.
    pool: "forks",
    fileParallelism: true,
    maxWorkers: Number(process.env.BAND_TEST_WORKERS ?? 3),
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-process-guard.ts", "tests/setup-failure-artifacts.ts"],
    include: loopbackOnly ? loopbackFiles : (quarantine.include ?? ["tests/**/*.test.ts"]),
    // Every server a test boots inherits this, so coding agents (including
    // the boot-time model probe) run as the scripted ACP stub rather than
    // the real Claude Code / Codex adapters (issue #648).
    env: {
      BAND_TEST_ACP_AGENT: resolve(import.meta.dirname, "tests/fixtures/acp-stub-agent.mjs"),
      // Servers with no UI report no activity; keep their 5 s poll and a fixed power state.
      BAND_ACTIVITY_DEFAULT: "active",
      BAND_POWER_STATE: "ac",
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
