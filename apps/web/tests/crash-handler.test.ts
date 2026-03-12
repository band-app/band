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

// The real built server entry point — same binary the Tauri app spawns.
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
 */
function runServerWithCrash(
  bandHome: string,
  triggerCode: string,
): Promise<{ exitCode: number | null; logContent: string }> {
  const triggerPath = join(bandHome, "crash-trigger.mjs");
  writeFileSync(triggerPath, triggerCode, "utf-8");

  return new Promise((resolve, reject) => {
    const child = spawn("node", [`--import`, pathToFileURL(triggerPath).href, serverScript], {
      env: { ...process.env, BAND_HOME: bandHome, PORT: "0" },
      stdio: "pipe",
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Server did not exit within 15 seconds"));
    }, 15_000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      const logPath = join(bandHome, "server.log");
      const logContent = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      resolve({ exitCode: code, logContent });
    });
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

  it("logs unhandled promise rejection to server.log and exits with code 1", async () => {
    const { exitCode, logContent } = await runServerWithCrash(
      bandHome,
      `setTimeout(() => { Promise.reject(new Error("test unhandled rejection")); }, 500);`,
    );

    expect(exitCode).toBe(1);
    expect(logContent).toContain("Unhandled rejection");
    expect(logContent).toContain("test unhandled rejection");
    expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("logs uncaught exception to server.log and exits with code 1", async () => {
    const { exitCode, logContent } = await runServerWithCrash(
      bandHome,
      `setTimeout(() => { throw new Error("test uncaught exception"); }, 500);`,
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
    );

    expect(logContent).toContain("stack trace test");
    expect(logContent).toMatch(/at\s/);
  });

  it("logs non-Error rejection values as strings", async () => {
    const { exitCode, logContent } = await runServerWithCrash(
      bandHome,
      `setTimeout(() => { Promise.reject("plain string rejection"); }, 500);`,
    );

    expect(exitCode).toBe(1);
    expect(logContent).toContain("plain string rejection");
  });
});
