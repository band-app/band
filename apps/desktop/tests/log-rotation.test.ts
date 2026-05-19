/**
 * Integration test for the desktop log rotation logic.
 *
 * Real filesystem, real `~/.band/desktop.log` (sandboxed via HOME).
 * Asserts that a >5MB log gets rotated to `.old` on next write
 * through a pino logger created by `createLogger()`.
 *
 * The pre-pino implementation had a `logToFile(msg)` helper that
 * the original test pointed at directly; after the migration to
 * pino (issue #444 cleanup), file writes go through pino's
 * destination stream — but the rotation check at the same 5MB
 * threshold survives. Test that the rotation still triggers when
 * a logger emits while the file is past the cap.
 */

import { strict as assert } from "node:assert";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createLogger, desktopLogPath } from "../src/main/services/log.ts";

describe("log rotation", () => {
  let sandboxHome: string;
  const originalHome = process.env.HOME;

  before(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "band-desktop-log-test-"));
    process.env.HOME = sandboxHome;
    await mkdir(join(sandboxHome, ".band"), { recursive: true });
  });

  after(async () => {
    process.env.HOME = originalHome;
    await rm(sandboxHome, { recursive: true, force: true });
  });

  test("rotates to .old when log exceeds 5MB", async () => {
    const path = desktopLogPath();
    const oldPath = `${path}.old`;

    // Write 5MB + 1 byte directly to simulate a long-running process's log.
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    await writeFile(path, big);
    assert.equal(statSync(path).size, big.length);

    // Triggering one more write through a pino logger should observe
    // the rotation. The logger writes synchronously to the
    // appendFileSync-backed destination registered by services/log.ts.
    const log = createLogger("log-rotation-test");
    log.info("post-rotation entry");
    // pino flushes synchronously for in-process destinations on a
    // single info call, but give the runtime one microtask to settle
    // any pending writes before we stat.
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(existsSync(oldPath), true, ".old should exist after rotation");
    // The fresh log contains only the post-rotation entry.
    const newSize = statSync(path).size;
    assert.ok(newSize < 1024, `expected fresh log <1KB, got ${newSize}`);
  });
});
