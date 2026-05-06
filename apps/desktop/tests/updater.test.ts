/**
 * Integration tests for the auto-updater logic.
 *
 * Per CLAUDE.md: black-box, no mocks of our own modules. The only thing we
 * substitute is the third-party `electron-updater` singleton (out of our
 * control + binds to the running Electron binary at module-load time —
 * impractical in CI). The substitution is via dependency injection at the
 * `checkForUpdate` call site, not a network or loader-level mock — so the
 * production code under test is exactly the same code that ships.
 *
 * Each test drives a fresh `FakeUpdater` through the same event sequence
 * the real `electron-updater` emits (`checking-for-update` →
 * `update-available` / `update-not-available` / `error` → optionally
 * `download-progress` ... → `update-downloaded`). Dialog interactions are
 * captured as a list, and the install path replaces `quitAndInstall` with
 * a `restart` callback so the test process doesn't actually exit.
 *
 * The startup-check schedule is exercised with a synthetic `delayMs: 0` so
 * the suite runs in <1s.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { type CheckForUpdateDeps, checkForUpdate, type UpdaterLike } from "../src/main/updater.ts";

// ---------------------------------------------------------------------------
// FakeUpdater: same event surface as electron-updater's AppUpdater singleton
// ---------------------------------------------------------------------------

interface FakeUpdaterOptions {
  /** Outcome to fire from `checkForUpdates`. Defaults to "not-available". */
  checkOutcome?: "available" | "not-available" | "error";
  /** Version to report in the `update-available` event. */
  version?: string;
  /** Error message for the "error" outcome. */
  errorMessage?: string;
  /** Outcome to fire from `downloadUpdate`. */
  downloadOutcome?: "downloaded" | "error";
  /** Error message for download failure. */
  downloadErrorMessage?: string;
}

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdatesCalls = 0;
  downloadUpdateCalls = 0;
  quitAndInstallCalls = 0;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private opts: FakeUpdaterOptions;

  constructor(opts: FakeUpdaterOptions = {}) {
    this.opts = opts;
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches the AppUpdater contract
  on(event: string, listener: (...args: any[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  removeAllListeners(event?: string): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }

  private emit(event: string, ...args: unknown[]): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const fn of arr) fn(...args);
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkForUpdatesCalls++;
    // Simulate the async dispatch: real electron-updater emits the event
    // off-microtask after the network round-trip completes.
    await Promise.resolve();
    const outcome = this.opts.checkOutcome ?? "not-available";
    if (outcome === "available") {
      this.emit("update-available", { version: this.opts.version ?? "1.2.3" });
    } else if (outcome === "not-available") {
      this.emit("update-not-available");
    } else {
      this.emit("error", new Error(this.opts.errorMessage ?? "boom"));
    }
    return null;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadUpdateCalls++;
    await Promise.resolve();
    if (this.opts.downloadOutcome === "error") {
      this.emit("error", new Error(this.opts.downloadErrorMessage ?? "download failed"));
      return [];
    }
    // Emit one progress tick so we can assert the listener path runs.
    this.emit("download-progress", {
      percent: 50,
      bytesPerSecond: 1024,
      transferred: 512,
      total: 1024,
    });
    this.emit("update-downloaded");
    return [];
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls++;
  }
}

interface DialogCall {
  kind: "info" | "confirm";
  title: string;
  message: string;
}

interface Recorder {
  dialogs: DialogCall[];
  restarts: number;
  deps: CheckForUpdateDeps;
}

/** Builds a fresh deps bundle that records every dialog + restart call. */
function recorder(updater: UpdaterLike, confirmAnswer = true): Recorder {
  const dialogs: DialogCall[] = [];
  let restarts = 0;
  const deps: CheckForUpdateDeps = {
    updater,
    showInfo: async (title, message) => {
      dialogs.push({ kind: "info", title, message });
    },
    showConfirm: async (title, message) => {
      dialogs.push({ kind: "confirm", title, message });
      return confirmAnswer;
    },
    restart: () => {
      restarts++;
    },
  };
  return {
    dialogs,
    get restarts() {
      return restarts;
    },
    deps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkForUpdate (silent / startup mode)", () => {
  test("no update available — no dialog, no restart", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    const rec = recorder(updater);

    await checkForUpdate(false, rec.deps);

    assert.equal(updater.checkForUpdatesCalls, 1);
    assert.equal(updater.downloadUpdateCalls, 0);
    assert.equal(rec.dialogs.length, 0);
    assert.equal(rec.restarts, 0);
  });

  test("check error — silent, no dialog", async () => {
    const updater = new FakeUpdater({
      checkOutcome: "error",
      errorMessage: "DNS lookup failed",
    });
    const rec = recorder(updater);

    await checkForUpdate(false, rec.deps);

    assert.equal(rec.dialogs.length, 0);
    assert.equal(updater.downloadUpdateCalls, 0);
  });

  test("update available + accepted — downloads and restarts", async () => {
    const updater = new FakeUpdater({
      checkOutcome: "available",
      version: "9.8.7",
    });
    const rec = recorder(updater, true);

    await checkForUpdate(false, rec.deps);

    // Confirm dialog fired with the version.
    assert.equal(rec.dialogs.length, 1);
    assert.equal(rec.dialogs[0]?.kind, "confirm");
    assert.equal(rec.dialogs[0]?.title, "Update Available");
    assert.match(rec.dialogs[0]?.message ?? "", /v9\.8\.7/);

    assert.equal(updater.downloadUpdateCalls, 1);
    assert.equal(rec.restarts, 1);
    // We never call quitAndInstall when restart override is supplied.
    assert.equal(updater.quitAndInstallCalls, 0);
  });

  test("update available + declined — no download, no restart", async () => {
    const updater = new FakeUpdater({
      checkOutcome: "available",
      version: "1.0.1",
    });
    const rec = recorder(updater, false);

    await checkForUpdate(false, rec.deps);

    assert.equal(rec.dialogs.length, 1);
    assert.equal(rec.dialogs[0]?.kind, "confirm");
    assert.equal(updater.downloadUpdateCalls, 0);
    assert.equal(rec.restarts, 0);
  });

  test("download fails — info dialog is shown", async () => {
    const updater = new FakeUpdater({
      checkOutcome: "available",
      version: "2.0.0",
      downloadOutcome: "error",
      downloadErrorMessage: "checksum mismatch",
    });
    const rec = recorder(updater, true);

    await checkForUpdate(false, rec.deps);

    // 1 confirm + 1 info (failure)
    assert.equal(rec.dialogs.length, 2);
    assert.equal(rec.dialogs[1]?.kind, "info");
    assert.equal(rec.dialogs[1]?.title, "Update Failed");
    assert.match(rec.dialogs[1]?.message ?? "", /checksum mismatch/);
    assert.equal(rec.restarts, 0);
  });

  test("autoDownload + autoInstallOnAppQuit are forced off", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    const rec = recorder(updater);

    await checkForUpdate(false, rec.deps);

    // We need to drive download + install ourselves so the user can confirm
    // before we touch their bandwidth. Regression-guard against someone
    // flipping these back to defaults.
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
  });
});

describe("checkForUpdate (interactive / menu mode)", () => {
  test("no update available — info dialog says you're up to date", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    const rec = recorder(updater);

    await checkForUpdate(true, rec.deps);

    assert.equal(rec.dialogs.length, 1);
    assert.equal(rec.dialogs[0]?.kind, "info");
    assert.equal(rec.dialogs[0]?.title, "No Updates Available");
  });

  test("check error — info dialog mentions the failure", async () => {
    const updater = new FakeUpdater({
      checkOutcome: "error",
      errorMessage: "503 Service Unavailable",
    });
    const rec = recorder(updater);

    await checkForUpdate(true, rec.deps);

    assert.equal(rec.dialogs.length, 1);
    assert.equal(rec.dialogs[0]?.kind, "info");
    assert.equal(rec.dialogs[0]?.title, "Update Error");
  });
});

describe("checkForUpdate listener teardown", () => {
  test("two back-to-back checks don't double-fire on the second outcome", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    const rec = recorder(updater);

    await checkForUpdate(false, rec.deps);
    await checkForUpdate(true, rec.deps);

    // Only the second (interactive) call should have surfaced a dialog.
    assert.equal(rec.dialogs.length, 1);
    assert.equal(rec.dialogs[0]?.kind, "info");
    assert.equal(rec.dialogs[0]?.title, "No Updates Available");
    assert.equal(updater.checkForUpdatesCalls, 2);
  });
});

describe("scheduleStartupCheck", () => {
  // Each test below toggles BAND_UPDATER_ENABLED. Because it's read once at
  // module init time, we re-import the module fresh per test via a dynamic
  // import + a unique cache-busting query param.
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.BAND_UPDATER_ENABLED;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BAND_UPDATER_ENABLED;
    else process.env.BAND_UPDATER_ENABLED = originalEnv;
  });

  test("returns no-op when UPDATER_ENABLED is false (env unset)", async () => {
    delete process.env.BAND_UPDATER_ENABLED;
    const mod = await freshUpdaterModule();
    const updater = new FakeUpdater({ checkOutcome: "available" });
    const cancel = mod.scheduleStartupCheck(true, {
      updater,
      delayMs: 5,
      showInfo: async () => undefined,
      showConfirm: async () => false,
    });

    await delay(30);
    cancel();
    assert.equal(updater.checkForUpdatesCalls, 0);
  });

  test("returns no-op when not packaged, even with UPDATER_ENABLED=1", async () => {
    process.env.BAND_UPDATER_ENABLED = "1";
    const mod = await freshUpdaterModule();
    const updater = new FakeUpdater({ checkOutcome: "available" });

    mod.scheduleStartupCheck(false, {
      updater,
      delayMs: 5,
      showInfo: async () => undefined,
      showConfirm: async () => false,
    });

    await delay(30);
    assert.equal(updater.checkForUpdatesCalls, 0);
  });

  test("fires checkForUpdate after delay when enabled + packaged", async () => {
    process.env.BAND_UPDATER_ENABLED = "1";
    const mod = await freshUpdaterModule();
    const updater = new FakeUpdater({ checkOutcome: "not-available" });

    mod.scheduleStartupCheck(true, {
      updater,
      delayMs: 10,
      showInfo: async () => undefined,
      showConfirm: async () => false,
    });

    // Just past the delay.
    await delay(50);
    assert.equal(updater.checkForUpdatesCalls, 1);
  });

  test("cancellation prevents the deferred check from running", async () => {
    process.env.BAND_UPDATER_ENABLED = "1";
    const mod = await freshUpdaterModule();
    const updater = new FakeUpdater({ checkOutcome: "available" });

    const cancel = mod.scheduleStartupCheck(true, {
      updater,
      delayMs: 50,
      showInfo: async () => undefined,
      showConfirm: async () => false,
    });
    cancel();

    await delay(80);
    assert.equal(updater.checkForUpdatesCalls, 0);
  });
});

/**
 * Force a fresh module load so `UPDATER_ENABLED` (evaluated at module init)
 * picks up the current value of `process.env.BAND_UPDATER_ENABLED`. Node's
 * ESM cache keys on resolved URL, so a unique query param sidesteps it.
 */
async function freshUpdaterModule(): Promise<typeof import("../src/main/updater.ts")> {
  const url = new URL("../src/main/updater.ts", import.meta.url);
  url.searchParams.set("t", String(Date.now()) + Math.random().toString(36).slice(2));
  return import(url.href);
}
