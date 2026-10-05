import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DaemonTerminalBackend,
  TerminalDaemonUnavailableError,
} from "@band-app/host-local/terminals/daemon/daemon-backend";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome } from "./helpers/server";
import { isAlive, startDaemonOfBuild, stopTerminalDaemon } from "./helpers/terminal-daemon";

// `DaemonTerminalBackend.openConnection` retries a failed launch once before
// giving up (see the terminal daemon resilience work): a one-off launch
// failure — a transient race, or a daemon that failed to load node-pty and
// exited fast — is worth a second attempt with a fresh process before
// abandoning the daemon backend for the rest of the server's life.
//
// Rather than racing a real timing window to fail exactly once, the "entry"
// each test points at is a small real Node script (not a mock of production
// code) that decides whether to fail based on how many times it has already
// been invoked, recorded in a plain counter file — a deterministic stand-in
// for "the first launch attempt happens to fail".

const DAEMON_ENTRY = resolve(import.meta.dirname, "../dist/terminal-daemon.mjs");

describe("terminal daemon backend — launch retry", () => {
  // Initialized to "" (not left `undefined` at runtime despite the `string`
  // type) so a failure before a test's own `createTmpHome()` call can't make
  // `afterEach` pass `undefined` to `rmSync`/`stopTerminalDaemon` and mask
  // the real failure behind a teardown crash.
  let tmpHome = "";

  afterEach(async () => {
    if (!tmpHome) return;
    await stopTerminalDaemon(tmpHome);
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A daemon entry that fails its first `failCount` invocations, then delegates to the real one. */
  function writeFlakyEntry(path: string, attemptsLog: string, failCount: number): void {
    writeFileSync(
      path,
      [
        `import { appendFileSync, readFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(attemptsLog)}, "x");`,
        `const attempts = readFileSync(${JSON.stringify(attemptsLog)}, "utf8").length;`,
        `if (attempts <= ${failCount}) { process.exit(1); }`,
        `await import(${JSON.stringify(DAEMON_ENTRY)});`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("recovers a session on the second attempt after the first launch fails", async () => {
    tmpHome = createTmpHome("band-td-retry-ok-");
    const bandHome = `${tmpHome}/.band`;
    const runDir = `${bandHome}/run`;
    const attemptsLog = `${tmpHome}/attempts.log`;
    const entry = `${tmpHome}/flaky-entry.mjs`;
    writeFlakyEntry(entry, attemptsLog, 1);

    const backend = new DaemonTerminalBackend({
      entry,
      runDir,
      cwd: bandHome,
      buildId: "retry-ok-test",
    });
    try {
      const entry1 = await backend.spawn({
        worktreeId: "ws-retry-ok",
        terminalId: randomUUID(),
        worktreeRoot: tmpHome,
      });
      expect(entry1.pid).toBeGreaterThan(0);
      // Exactly two launches were attempted: the failing one and the one that succeeded.
      expect(readFileSync(attemptsLog, "utf8")).toHaveLength(2);
    } finally {
      await backend.close();
    }
  });

  it("gives up after exhausting its attempts, and never touches a stale daemon's shells", async () => {
    tmpHome = createTmpHome("band-td-retry-fail-");
    const bandHome = `${tmpHome}/.band`;
    const runDir = `${bandHome}/run`;
    const attemptsLog = `${tmpHome}/attempts.log`;
    const entry = `${tmpHome}/always-fails-entry.mjs`;
    // Never delegates: every attempt fails.
    writeFlakyEntry(entry, attemptsLog, Number.POSITIVE_INFINITY);

    // A live daemon of another build already serves the endpoint, the way
    // #652/#653 describe — it must be left running untouched.
    const old = await startDaemonOfBuild(tmpHome, { entry: DAEMON_ENTRY, buildId: "old-build" });
    const oldTerminalId = randomUUID();
    const oldShellPid = await old.spawnShell({
      worktreeId: "ws-old",
      terminalId: oldTerminalId,
      worktreeRoot: tmpHome,
    });

    const backend = new DaemonTerminalBackend({
      entry,
      runDir,
      cwd: bandHome,
      buildId: "retry-fail-test",
    });
    try {
      await expect(
        backend.spawn({
          worktreeId: "ws-retry-fail",
          terminalId: randomUUID(),
          worktreeRoot: tmpHome,
        }),
      ).rejects.toThrow(TerminalDaemonUnavailableError);
      // Exactly LAUNCH_ATTEMPTS (2) attempts, not one and not unbounded retries.
      expect(readFileSync(attemptsLog, "utf8")).toHaveLength(2);

      // The stale daemon and its shell are untouched by the failed attempts.
      expect(isAlive(old.pid)).toBe(true);
      expect(isAlive(oldShellPid)).toBe(true);
    } finally {
      await backend.close();
    }
  });
});
