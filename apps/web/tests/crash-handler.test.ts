import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_RUNTIME } from "./helpers/server-runtime";

// The real built server entry point — same binary the Electron app spawns.
const serverScript = join(import.meta.dirname, "../dist/start-server.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpBandHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "band-crash-test-")));
}

/**
 * Start the real production server (`dist/start-server.mjs`) with a
 * preloaded ESM module that triggers a crash after a short delay.
 *
 * Uses Node's `--import` flag so the crash-trigger module is loaded before
 * the server, but the setTimeout callback fires *after* the server's
 * top-level crash handlers have been registered.
 *
 * `mode` controls how the harness waits:
 *
 *   • "wait-for-exit" — used by tests that expect the server to exit on
 *     its own (uncaughtException path). The harness reads `exitCode` from
 *     the `exit` event.
 *   • "kill-after-log" — used by tests that expect the server to LOG and
 *     KEEP RUNNING (unhandledRejection path, post-Node-22 policy where
 *     rejections in background tasks must not single-point-of-failure the
 *     whole server). The harness polls `server.log` until the expected
 *     substring appears, then sends SIGTERM and returns. `exitCode` is
 *     reported as the result of that termination — useful for asserting
 *     "did not exit on its own" via the `crashed` flag.
 */
function runServerWithCrash(
  bandHome: string,
  triggerCode: string,
  options: { mode: "wait-for-exit" } | { mode: "kill-after-log"; expectInLog: string },
): Promise<{ exitCode: number | null; logContent: string; crashedOnOwn: boolean }> {
  const triggerPath = join(bandHome, "crash-trigger.mjs");
  writeFileSync(triggerPath, triggerCode, "utf-8");

  return new Promise((resolve, reject) => {
    const child = spawn(
      SERVER_RUNTIME,
      ["--import", pathToFileURL(triggerPath).href, serverScript],
      {
        env: { ...process.env, BAND_HOME: bandHome, PORT: "0" },
        stdio: "pipe",
      },
    );

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    // Tracks whether the test harness deliberately killed the child. If
    // the child exits before this flips, the server crashed on its own
    // (which is the expected outcome for `wait-for-exit` mode and the
    // failure-to-detect outcome for `kill-after-log` mode).
    let harnessSentKill = false;

    const timer = setTimeout(() => {
      if (pollTimer) clearInterval(pollTimer);
      harnessSentKill = true;
      child.kill("SIGKILL");
      reject(new Error("Server did not exit within 15 seconds"));
    }, 15_000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      const logPath = join(bandHome, "server.log");
      const logContent = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      resolve({ exitCode: code, logContent, crashedOnOwn: !harnessSentKill });
    });

    if (options.mode === "wait-for-exit") {
      // Server is expected to exit on its own (uncaughtException path).
      // The exit listener above does the resolve.
      return;
    }

    // kill-after-log: poll the server log every 100 ms until the expected
    // substring appears, then SIGTERM. Cap at 10 s so a missing log entry
    // surfaces as the outer 15 s reject rather than hanging silently.
    const logPath = join(bandHome, "server.log");
    pollTimer = setInterval(() => {
      try {
        if (!existsSync(logPath)) return;
        const log = readFileSync(logPath, "utf-8");
        if (log.includes(options.expectInLog)) {
          if (pollTimer) clearInterval(pollTimer);
          // Give the handler a final tick to finish writing before we
          // terminate — avoids a partial-write race in CI.
          setTimeout(() => {
            harnessSentKill = true;
            child.kill("SIGTERM");
          }, 100);
        }
      } catch {
        // Ignore transient read errors during writes.
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server crash handlers", () => {
  let bandHome: string;

  beforeEach(() => {
    bandHome = createTmpBandHome();
  });

  afterEach(() => {
    rmSync(bandHome, { recursive: true, force: true });
  });

  it("logs unhandled promise rejection to server.log and keeps the server running", async () => {
    // Policy change: unhandled rejections used to trigger process.exit(1).
    // That made every background task (e.g. the boot-time model refresh)
    // a single point of failure for the whole server. The handler now
    // logs and returns — real fatal errors still surface through
    // `uncaughtException`, which still exits. See start-server.ts for the
    // full rationale.
    const { logContent, crashedOnOwn } = await runServerWithCrash(
      bandHome,
      `setTimeout(() => { Promise.reject(new Error("test unhandled rejection")); }, 500);`,
      { mode: "kill-after-log", expectInLog: "test unhandled rejection" },
    );

    expect(crashedOnOwn).toBe(false);
    expect(logContent).toContain("Unhandled rejection");
    expect(logContent).toContain("test unhandled rejection");
    expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("logs uncaught exception to server.log and exits with code 1", async () => {
    const { exitCode, logContent } = await runServerWithCrash(
      bandHome,
      `setTimeout(() => { throw new Error("test uncaught exception"); }, 500);`,
      { mode: "wait-for-exit" },
    );

    expect(exitCode).toBe(1);
    expect(logContent).toContain("Uncaught exception");
    expect(logContent).toContain("test uncaught exception");
    expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes stack trace in log output", async () => {
    const { logContent } = await runServerWithCrash(
      bandHome,
      `setTimeout(() => { throw new Error("stack trace test"); }, 500);`,
      { mode: "wait-for-exit" },
    );

    expect(logContent).toContain("stack trace test");
    expect(logContent).toMatch(/at\s/);
  });

  it("logs non-Error rejection values as strings without crashing", async () => {
    const { logContent, crashedOnOwn } = await runServerWithCrash(
      bandHome,
      `setTimeout(() => { Promise.reject("plain string rejection"); }, 500);`,
      { mode: "kill-after-log", expectInLog: "plain string rejection" },
    );

    expect(crashedOnOwn).toBe(false);
    expect(logContent).toContain("plain string rejection");
  });
});
