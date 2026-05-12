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
import { beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  __resetUpdaterGuardsForTests,
  type CheckForUpdateDeps,
  checkForUpdate,
  checkForUpdateBackground,
  installPendingUpdate,
  type PendingUpdate,
  pickAutoUpdater,
  schedulePeriodicCheck,
  scheduleStartupCheck,
  type UpdaterLike,
} from "../src/main/updater.ts";

// Module-scoped guards (`inFlightCheck`, `inFlightInstall`) persist across
// the suite. Reset them before every test so a previous "skip" case doesn't
// leak into the next.
beforeEach(() => {
  __resetUpdaterGuardsForTests();
});

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
  test("returns no-op when not packaged (dev runs)", async () => {
    const updater = new FakeUpdater({ checkOutcome: "available" });

    scheduleStartupCheck(false, {
      updater,
      delayMs: 5,
      showInfo: async () => undefined,
      showConfirm: async () => false,
    });

    await delay(30);
    assert.equal(updater.checkForUpdatesCalls, 0);
  });

  test("fires checkForUpdate after delay when packaged", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });

    scheduleStartupCheck(true, {
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
    const updater = new FakeUpdater({ checkOutcome: "available" });

    const cancel = scheduleStartupCheck(true, {
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

// ---------------------------------------------------------------------------
// pickAutoUpdater
// ---------------------------------------------------------------------------
//
// Regression test for the bug shipped through v0.5.3: `electron-updater`
// exposes `autoUpdater` via a CJS getter, and Node's dynamic-`import()` ESM
// interop does not hoist getter-defined props onto the namespace's named
// exports — they're reachable only through `.default`. The original code
// read `mod.autoUpdater`, got `undefined`, and threw
//   "Cannot set properties of undefined (setting 'autoDownload')"
// when the user clicked "Check for Updates…".

describe("pickAutoUpdater", () => {
  test("prefers .default.autoUpdater (CJS-via-import shape)", () => {
    const fake = {} as UpdaterLike;
    const mod = { default: { autoUpdater: fake } };
    assert.equal(pickAutoUpdater(mod), fake);
  });

  test("falls back to .autoUpdater when .default is absent", () => {
    const fake = {} as UpdaterLike;
    const mod = { autoUpdater: fake };
    assert.equal(pickAutoUpdater(mod), fake);
  });

  test("throws when neither shape exposes a singleton", () => {
    // This is the v0.5.3 shipped state: named keys are present but
    // `autoUpdater` is undefined because Node didn't hoist the CJS getter.
    const mod = { default: {}, AppUpdater: class {} };
    assert.throws(() => pickAutoUpdater(mod), /did not expose autoUpdater singleton/);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdateBackground — silent check used by the 10s startup + 2h
// periodic banner pipeline. No dialogs. Returns { version } or null.
// ---------------------------------------------------------------------------

describe("checkForUpdateBackground", () => {
  test("returns { version } when an update is available", async () => {
    const updater = new FakeUpdater({ checkOutcome: "available", version: "4.5.6" });
    const result = await checkForUpdateBackground({ updater });
    assert.deepEqual(result, { version: "4.5.6" });
    assert.equal(updater.checkForUpdatesCalls, 1);
    assert.equal(updater.downloadUpdateCalls, 0); // banner-driven, not auto-download
  });

  test("returns null when no update is available", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    const result = await checkForUpdateBackground({ updater });
    assert.equal(result, null);
  });

  test("returns null on error (silent — no dialog escape hatch)", async () => {
    const updater = new FakeUpdater({ checkOutcome: "error", errorMessage: "503" });
    const result = await checkForUpdateBackground({ updater });
    assert.equal(result, null);
  });

  test("forces autoDownload + autoInstallOnAppQuit off", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    await checkForUpdateBackground({ updater });
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
  });

  test("back-to-back calls don't cross-fire listeners", async () => {
    const updater = new FakeUpdater({ checkOutcome: "available", version: "1.0.0" });
    const r1 = await checkForUpdateBackground({ updater });
    const r2 = await checkForUpdateBackground({ updater });
    assert.deepEqual(r1, { version: "1.0.0" });
    assert.deepEqual(r2, { version: "1.0.0" });
    assert.equal(updater.checkForUpdatesCalls, 2);
  });

  test("skips when a check is already in flight (shared mutex)", async () => {
    // Hold the first call inside `performCheck` by capturing the
    // `update-not-available` listener and only invoking it once we want
    // the first call to complete. Until then `inFlightCheck` is true and
    // any second call should no-op.
    let notAvailableListener: (() => void) | null = null;
    const blockingUpdater: UpdaterLike = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on(event: string, listener: (...args: unknown[]) => void): void {
        if (event === "update-not-available") notAvailableListener = listener as () => void;
      },
      removeAllListeners(): void {
        notAvailableListener = null;
      },
      async checkForUpdates() {
        return null; // resolves but doesn't emit — we drive the event below
      },
      async downloadUpdate() {
        return null;
      },
      quitAndInstall() {},
    };

    const first = checkForUpdateBackground({ updater: blockingUpdater });
    // Yield so the first call enters performCheck and registers its listener.
    await delay(5);

    // Second call: should no-op without touching its updater.
    const tracker = new FakeUpdater({ checkOutcome: "available" });
    const second = await checkForUpdateBackground({ updater: tracker });
    assert.equal(second, null);
    assert.equal(tracker.checkForUpdatesCalls, 0);

    // Unblock the first call.
    notAvailableListener?.();
    const firstResult = await first;
    assert.equal(firstResult, null);
  });
});

// ---------------------------------------------------------------------------
// installPendingUpdate — banner-driven install. No dialogs.
// ---------------------------------------------------------------------------

describe("installPendingUpdate", () => {
  test("downloads and restarts on success", async () => {
    const updater = new FakeUpdater({
      checkOutcome: "available", // unused — we don't run a check here
      downloadOutcome: "downloaded",
    });
    let restarts = 0;
    await installPendingUpdate({ updater, restart: () => restarts++ });
    assert.equal(updater.downloadUpdateCalls, 1);
    assert.equal(restarts, 1);
  });

  test("throws when the download fails (renderer flips banner to error)", async () => {
    const updater = new FakeUpdater({
      downloadOutcome: "error",
      downloadErrorMessage: "checksum",
    });
    await assert.rejects(installPendingUpdate({ updater, restart: () => undefined }), /checksum/);
  });

  test("skips when an install is already in flight (mutex)", async () => {
    // Hold the first install in the download phase by capturing the
    // `update-downloaded` listener but never invoking it until we say so.
    let downloadedListener: (() => void) | null = null;
    let resolveDownload: (() => void) | null = null;
    const blockingUpdater: UpdaterLike = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on(event: string, listener: (...args: unknown[]) => void): void {
        if (event === "update-downloaded") downloadedListener = listener as () => void;
      },
      removeAllListeners(): void {
        downloadedListener = null;
      },
      async checkForUpdates() {
        return null;
      },
      async downloadUpdate() {
        return new Promise<void>((resolve) => {
          resolveDownload = resolve;
        });
      },
      quitAndInstall() {},
    };

    let firstRestarts = 0;
    const first = installPendingUpdate({
      updater: blockingUpdater,
      restart: () => firstRestarts++,
    });
    // Yield so the first call sets the guard and registers its listener.
    await delay(5);

    // Second call: should bail on the mutex without touching its updater.
    const tracker = new FakeUpdater({ downloadOutcome: "downloaded" });
    await installPendingUpdate({ updater: tracker, restart: () => undefined });
    assert.equal(tracker.downloadUpdateCalls, 0);

    // Unblock the first install so the test ends cleanly: emit downloaded,
    // then resolve `downloadUpdate`'s promise.
    downloadedListener?.();
    resolveDownload?.();
    await first;
    assert.equal(firstRestarts, 1);
  });
});

// ---------------------------------------------------------------------------
// schedulePeriodicCheck — 2h ticker, banner-driven.
// ---------------------------------------------------------------------------

describe("schedulePeriodicCheck", () => {
  test("returns no-op when not packaged (dev runs)", async () => {
    const updater = new FakeUpdater({ checkOutcome: "available" });
    let results = 0;
    schedulePeriodicCheck(false, {
      updater,
      intervalMs: 10,
      onResult: () => results++,
    });
    await delay(40);
    assert.equal(updater.checkForUpdatesCalls, 0);
    assert.equal(results, 0);
  });

  test("fires onResult on every tick", async () => {
    const updater = new FakeUpdater({ checkOutcome: "available", version: "2.0.0" });
    const observed: PendingUpdate[] = [];
    const cancel = schedulePeriodicCheck(true, {
      updater,
      intervalMs: 15,
      onResult: (p) => observed.push(p),
    });

    // Wait for a few ticks. setInterval doesn't fire immediately — first tick
    // lands at ~intervalMs.
    await delay(55);
    cancel();

    assert.ok(observed.length >= 2, `expected >=2 ticks, got ${observed.length}`);
    for (const o of observed) {
      assert.deepEqual(o, { version: "2.0.0" });
    }
  });

  test("cancellation stops further ticks", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    let results = 0;
    const cancel = schedulePeriodicCheck(true, {
      updater,
      intervalMs: 10,
      onResult: () => results++,
    });
    // Let one tick fire, then cancel.
    await delay(25);
    cancel();
    const callsAfterCancel = updater.checkForUpdatesCalls;
    await delay(40);
    assert.equal(updater.checkForUpdatesCalls, callsAfterCancel);
  });
});

// ---------------------------------------------------------------------------
// scheduleStartupCheck — refactored to use the background flow + onResult.
// ---------------------------------------------------------------------------

describe("scheduleStartupCheck (background mode)", () => {
  test("invokes onResult with the available update", async () => {
    const updater = new FakeUpdater({ checkOutcome: "available", version: "7.7.7" });
    let observed: PendingUpdate = "sentinel" as unknown as PendingUpdate;
    scheduleStartupCheck(true, {
      updater,
      delayMs: 5,
      onResult: (p) => {
        observed = p;
      },
    });
    await delay(40);
    assert.deepEqual(observed, { version: "7.7.7" });
  });

  test("invokes onResult with null when no update is available", async () => {
    const updater = new FakeUpdater({ checkOutcome: "not-available" });
    let observed: PendingUpdate = "sentinel" as unknown as PendingUpdate;
    scheduleStartupCheck(true, {
      updater,
      delayMs: 5,
      onResult: (p) => {
        observed = p;
      },
    });
    await delay(40);
    assert.equal(observed, null);
  });
});
