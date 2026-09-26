/**
 * Integration tests for the auto-update controller behind the update toast.
 *
 * Black-box, no mocks of our own modules. The only thing we
 * substitute is the third-party `electron-updater` singleton, which binds to
 * the running Electron binary at module load and cannot run under plain
 * Node. The controller takes it through `loadUpdater`, so the code under
 * test is the code that ships. Assertions go through the controller's
 * public surface: the statuses it broadcasts (what the renderer's toast
 * receives over `updater-status-changed`) and `getStatus()` (what
 * `updater_status` returns).
 *
 * `FakeUpdater` behaves like electron-updater 6: `checkForUpdates` resolves
 * with `{ isUpdateAvailable, updateInfo }` or rejects, `downloadUpdate`
 * emits `download-progress` and resolves or rejects.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  pickAutoUpdater,
  UpdateController,
  type UpdateInfoLike,
  type UpdaterLike,
  type UpdateStatus,
} from "../src/main/updater.ts";

const CURRENT = "0.30.0";

interface FakeUpdaterOptions {
  /** Latest release in the feed. `null` means the feed has nothing newer. */
  latest?: UpdateInfoLike | null;
  /** Reject `checkForUpdates` with this message. */
  checkError?: string;
  /** Reject `downloadUpdate` with this message (first call only when `downloadFailsOnce`). */
  downloadError?: string;
  downloadFailsOnce?: boolean;
  /** Hold `checkForUpdates` until `releaseCheck()` is called. */
  holdCheck?: boolean;
}

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkCalls = 0;
  downloadCalls = 0;
  quitAndInstallCalls = 0;
  private listeners = new Map<string, Array<(arg: never) => void>>();
  private releaseHeldCheck: (() => void) | null = null;
  opts: FakeUpdaterOptions;

  constructor(opts: FakeUpdaterOptions = {}) {
    this.opts = opts;
  }

  on(event: string, listener: (arg: never) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  private emit(event: string, arg: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(arg as never);
  }

  releaseCheck(): void {
    this.releaseHeldCheck?.();
  }

  async checkForUpdates() {
    this.checkCalls++;
    if (this.opts.holdCheck) {
      await new Promise<void>((resolve) => {
        this.releaseHeldCheck = resolve;
      });
    }
    await Promise.resolve();
    if (this.opts.checkError) {
      const err = new Error(this.opts.checkError);
      this.emit("error", err);
      throw err;
    }
    const latest = this.opts.latest ?? null;
    if (!latest) {
      return { isUpdateAvailable: false, updateInfo: { version: CURRENT } };
    }
    return { isUpdateAvailable: true, updateInfo: latest };
  }

  async downloadUpdate() {
    this.downloadCalls++;
    await Promise.resolve();
    if (this.opts.downloadError && (!this.opts.downloadFailsOnce || this.downloadCalls === 1)) {
      const err = new Error(this.opts.downloadError);
      this.emit("error", err);
      throw err;
    }
    for (const percent of [12.4, 12.9, 57.2, 100]) {
      this.emit("download-progress", { percent });
    }
    return ["/tmp/Band.zip"];
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls++;
  }
}

interface Harness {
  controller: UpdateController;
  updater: FakeUpdater;
  statuses: UpdateStatus[];
  restarts: number;
  clock: { now: number };
}

function harness(opts: FakeUpdaterOptions = {}): Harness {
  const updater = new FakeUpdater(opts);
  const statuses: UpdateStatus[] = [];
  const clock = { now: 1_000_000 };
  const h: Harness = {
    updater,
    statuses,
    restarts: 0,
    clock,
    controller: new UpdateController({
      currentVersion: CURRENT,
      onStatus: (s) => statuses.push(s),
      loadUpdater: async () => updater,
      restart: () => {
        h.restarts++;
      },
      now: () => clock.now,
    }),
  };
  return h;
}

const RELEASE: UpdateInfoLike = {
  version: "0.31.0",
  releaseName: "v0.31.0",
  releaseNotes:
    "<ul>\n<li>feat(web): update toast &amp; hourly checks (#663)</li>\n<li>fix(web): keep rows &lt;inside&gt; the pane</li>\n</ul>",
};

const RELEASE_FIELDS = {
  version: "0.31.0",
  currentVersion: CURRENT,
  releaseName: "v0.31.0",
  releaseNotes:
    "• feat(web): update toast & hourly checks (#663)\n• fix(web): keep rows <inside> the pane",
  releaseUrl: "https://github.com/band-app/band/releases/tag/v0.31.0",
};

describe("background checks (startup + interval)", () => {
  test("no update: status stays idle and nothing is broadcast", async () => {
    const h = harness();
    await h.controller.check({ userInitiated: false });
    assert.equal(h.updater.checkCalls, 1);
    assert.deepEqual(h.statuses, []);
    assert.deepEqual(h.controller.getStatus(), { state: "idle" });
  });

  test("check error: stays silent", async () => {
    const h = harness({ checkError: "net::ERR_INTERNET_DISCONNECTED" });
    await h.controller.check({ userInitiated: false });
    assert.deepEqual(h.statuses, []);
    assert.deepEqual(h.controller.getStatus(), { state: "idle" });
  });

  test("update found: broadcasts the release with plain-text notes and a release link", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    assert.deepEqual(h.statuses, [{ state: "available", ...RELEASE_FIELDS }]);
    assert.deepEqual(h.controller.getStatus(), { state: "available", ...RELEASE_FIELDS });
  });

  test("the updater is configured for a toast-driven download that installs on quit", async () => {
    const h = harness();
    await h.controller.check({ userInitiated: false });
    assert.equal(h.updater.autoDownload, false);
    assert.equal(h.updater.autoInstallOnAppQuit, true);
    // An `error` listener keeps the emitter from throwing on failures.
    assert.equal(h.updater.listenerCount("error"), 1);
  });

  test("repeated checks don't stack updater listeners", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    await h.controller.check({ userInitiated: false });
    await h.controller.check({ userInitiated: true });
    assert.equal(h.updater.listenerCount("error"), 1);
    assert.equal(h.updater.listenerCount("download-progress"), 1);
  });

  test("an unchanged result is not re-broadcast", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    await h.controller.check({ userInitiated: false });
    assert.equal(h.updater.checkCalls, 2);
    assert.equal(h.statuses.length, 1);
  });

  test("a release pulled from the feed clears the offer", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    h.updater.opts.latest = null;
    await h.controller.check({ userInitiated: false });
    assert.deepEqual(h.controller.getStatus(), { state: "idle" });
  });

  test("a dismissed version stays hidden on later background checks", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    h.controller.dismiss();
    await h.controller.check({ userInitiated: false });
    assert.deepEqual(h.controller.getStatus(), { state: "idle" });

    h.updater.opts.latest = { version: "0.32.0" };
    await h.controller.check({ userInitiated: false });
    const status = h.controller.getStatus();
    assert.equal(status.state, "available");
    assert.equal(status.state === "available" && status.version, "0.32.0");
  });
});

describe("user-initiated checks (Check for Updates…)", () => {
  test("no update: checking, then up to date with the current version", async () => {
    const h = harness();
    await h.controller.check({ userInitiated: true });
    assert.deepEqual(h.statuses, [
      { state: "checking", userInitiated: true },
      { state: "up-to-date", currentVersion: CURRENT, userInitiated: true },
    ]);
  });

  test("update found: checking, then the release", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: true });
    assert.deepEqual(h.statuses, [
      { state: "checking", userInitiated: true },
      { state: "available", ...RELEASE_FIELDS },
    ]);
  });

  test("check error: checking, then the error", async () => {
    const h = harness({ checkError: "HttpError: 404" });
    await h.controller.check({ userInitiated: true });
    assert.deepEqual(h.statuses, [
      { state: "checking", userInitiated: true },
      { state: "error", message: "HttpError: 404", phase: "check", userInitiated: true },
    ]);
  });

  test("shows a version the user dismissed earlier", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    h.controller.dismiss();
    await h.controller.check({ userInitiated: true });
    assert.deepEqual(h.controller.getStatus(), { state: "available", ...RELEASE_FIELDS });
  });

  test("an up-to-date result can be dismissed back to idle", async () => {
    const h = harness();
    await h.controller.check({ userInitiated: true });
    h.controller.dismiss();
    assert.deepEqual(h.controller.getStatus(), { state: "idle" });
  });
});

describe("overlapping checks", () => {
  test("concurrent checks share one request to the feed", async () => {
    const h = harness({ latest: RELEASE, holdCheck: true });
    const a = h.controller.check({ userInitiated: false });
    const b = h.controller.check({ userInitiated: false });
    await delay(5);
    h.updater.releaseCheck();
    await Promise.all([a, b]);
    assert.equal(h.updater.checkCalls, 1);
  });

  test("a menu check during a background check joins it and shows its result", async () => {
    const h = harness({ holdCheck: true });
    const background = h.controller.check({ userInitiated: false });
    await delay(5);
    const menu = h.controller.check({ userInitiated: true });
    assert.deepEqual(h.controller.getStatus(), { state: "checking", userInitiated: true });
    h.updater.releaseCheck();
    await Promise.all([background, menu]);
    assert.equal(h.updater.checkCalls, 1);
    assert.deepEqual(h.controller.getStatus(), {
      state: "up-to-date",
      currentVersion: CURRENT,
      userInitiated: true,
    });
  });
});

describe("download and restart", () => {
  test("Update downloads with progress, then offers a restart", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    h.statuses.length = 0;

    await h.controller.download();

    assert.equal(h.updater.downloadCalls, 1);
    assert.deepEqual(
      h.statuses.map((s) => (s.state === "downloading" ? `downloading ${s.percent}` : s.state)),
      ["downloading 0", "downloading 12", "downloading 57", "downloading 100", "downloaded"],
    );
    assert.deepEqual(h.controller.getStatus(), { state: "downloaded", ...RELEASE_FIELDS });
    assert.equal(h.restarts, 0);

    h.controller.restart();
    assert.equal(h.restarts, 1);
  });

  test("a download failure is reported and Retry downloads again", async () => {
    const h = harness({
      latest: RELEASE,
      downloadError: "sha512 checksum mismatch",
      downloadFailsOnce: true,
    });
    await h.controller.check({ userInitiated: false });
    await h.controller.download();
    assert.deepEqual(h.controller.getStatus(), {
      state: "error",
      message: "sha512 checksum mismatch",
      phase: "download",
      userInitiated: true,
    });

    await h.controller.download();
    assert.equal(h.updater.downloadCalls, 2);
    assert.equal(h.controller.getStatus().state, "downloaded");
  });

  test("a second click while downloading does not start another download", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    await Promise.all([h.controller.download(), h.controller.download()]);
    assert.equal(h.updater.downloadCalls, 1);
  });

  test("download does nothing without an available update", async () => {
    const h = harness();
    await h.controller.check({ userInitiated: true });
    await h.controller.download();
    assert.equal(h.updater.downloadCalls, 0);
  });

  test("restart does nothing before a download finishes", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    h.controller.restart();
    assert.equal(h.restarts, 0);
  });

  test("after a download, checks skip the feed; a menu check brings back the restart offer", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    await h.controller.download();
    h.controller.dismiss();

    await h.controller.check({ userInitiated: false });
    assert.deepEqual(h.controller.getStatus(), { state: "idle" });

    await h.controller.check({ userInitiated: true });
    assert.equal(h.updater.checkCalls, 1);
    assert.deepEqual(h.controller.getStatus(), { state: "downloaded", ...RELEASE_FIELDS });
  });

  test("the toast can't be dismissed mid-download", async () => {
    const h = harness({ latest: RELEASE });
    await h.controller.check({ userInitiated: false });
    const download = h.controller.download();
    h.controller.dismiss();
    assert.equal(h.controller.getStatus().state, "downloading");
    await download;
  });
});

describe("scheduling", () => {
  test("checks after the startup delay, then on every interval, until stopped", async () => {
    const h = harness();
    const stop = h.controller.start({ startupDelayMs: 5, intervalMs: 200 });
    assert.equal(h.updater.checkCalls, 0);
    await delay(50);
    assert.equal(h.updater.checkCalls, 1);
    await delay(400);
    stop();
    const calls = h.updater.checkCalls;
    assert.ok(calls >= 3, `expected startup + >=2 interval checks, got ${calls}`);
    await delay(250);
    assert.equal(h.updater.checkCalls, calls);
    // Background checks with no update never show the toast.
    assert.deepEqual(h.statuses, []);
  });

  test("stopping before the startup delay prevents any check", async () => {
    const h = harness();
    const stop = h.controller.start({ startupDelayMs: 10, intervalMs: 10_000 });
    stop();
    await delay(30);
    assert.equal(h.updater.checkCalls, 0);
  });

  test("on wake, checks only when the last check is older than the interval", async () => {
    const h = harness();
    await h.controller.check({ userInitiated: false });
    h.clock.now += 10 * 60 * 1000;
    h.controller.checkIfStale();
    await delay(5);
    assert.equal(h.updater.checkCalls, 1);

    h.clock.now += 60 * 60 * 1000;
    h.controller.checkIfStale();
    await delay(5);
    assert.equal(h.updater.checkCalls, 2);
  });
});

describe("release notes", () => {
  test("long notes are truncated", async () => {
    const note = `<p>${"a".repeat(2000)}</p>`;
    const h = harness({ latest: { version: "0.31.0", releaseNotes: note } });
    await h.controller.check({ userInitiated: false });
    const status = h.controller.getStatus();
    assert.equal(status.state, "available");
    const notes = status.state === "available" ? status.releaseNotes : null;
    assert.equal(notes, `${"a".repeat(600)}…`);
  });

  test("missing notes and name come through as null", async () => {
    const h = harness({ latest: { version: "0.31.0" } });
    await h.controller.check({ userInitiated: false });
    const status = h.controller.getStatus();
    assert.equal(status.state === "available" && status.releaseNotes, null);
    assert.equal(status.state === "available" && status.releaseName, null);
  });
});

describe("failure to load electron-updater", () => {
  test("a menu check reports it in the toast", async () => {
    const statuses: UpdateStatus[] = [];
    const controller = new UpdateController({
      currentVersion: CURRENT,
      onStatus: (s) => statuses.push(s),
      loadUpdater: async () => pickAutoUpdater({ default: {} }),
    });
    await controller.check({ userInitiated: true });
    const last = statuses.at(-1);
    assert.equal(last?.state, "error");
    assert.match(last?.state === "error" ? last.message : "", /did not expose autoUpdater/);
  });
});

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
