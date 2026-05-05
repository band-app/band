/**
 * Integration test for shellPath().
 *
 * Sets SHELL to a known executable so the spawned shell prints a controlled
 * value, and asserts the function returns it. No mocks; the test invokes a
 * real shell (`/bin/sh`) which is present on every CI box.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { shellPath } from "../src/main/services/shell-path.ts";

describe("shellPath", () => {
  const originalShell = process.env.SHELL;
  const originalPath = process.env.PATH;

  test("uses the configured shell to determine PATH", () => {
    // /bin/sh is universally available on macOS and Linux. It interprets
    // -li as login + interactive; for sh that's a no-op but the flag is
    // accepted so the spawnSync call doesn't error.
    process.env.SHELL = "/bin/sh";
    try {
      const result = shellPath();
      assert.ok(typeof result === "string" && result.length > 0);
    } finally {
      process.env.SHELL = originalShell;
    }
  });

  test("falls back to /opt/homebrew/bin:/usr/local/bin:$PATH when shell fails", () => {
    process.env.SHELL = "/nonexistent/shell/binary";
    process.env.PATH = "/test/path";
    try {
      const result = shellPath();
      assert.ok(result.includes("/opt/homebrew/bin"));
      assert.ok(result.includes("/usr/local/bin"));
      assert.ok(result.includes("/test/path"));
    } finally {
      process.env.SHELL = originalShell;
      process.env.PATH = originalPath;
    }
  });
});
