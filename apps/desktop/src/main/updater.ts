/**
 * Auto-updater, backed by `electron-updater` and the GitHub Releases feed
 * configured in `electron-builder.yml` (`latest-mac.yml` on band-app/band).
 *
 * `UpdateController` owns the whole update flow and its state. The renderer
 * shows that state as a bottom-right toast (`UpdateToast` in apps/web): it
 * reads it once with `updater_status`, follows `updater-status-changed`, and
 * drives the flow with `updater_check` / `updater_download` /
 * `updater_restart` / `updater_dismiss`. The only OS dialogs are the menu
 * check's fallback in `index.ts` for when no dashboard window is open.
 *
 * Checks run 10s after launch, every hour after that, and on wake from sleep
 * when the last check is older than the interval. These background checks
 * change the status only when they find an update, so the toast appears only
 * then. The "Check for Updates…" menu item runs a user-initiated check, which
 * the toast follows from "Checking for updates…" to its result. Only one
 * check runs at a time: a check requested while one is in flight joins it.
 *
 * Lazy electron imports: this file never imports `electron` or
 * `electron-updater` at module load. Both bind to the running Electron
 * binary, so a plain `node` process (the integration tests) cannot load
 * them. The controller loads the live `autoUpdater` on first use; tests pass
 * `loadUpdater` returning a fake with the same surface.
 */

import type { UpdateRelease, UpdateStatus } from "../shared/update-status.js";
import { createLogger } from "./services/log.js";

const log = createLogger("updater");

export type { UpdateRelease, UpdateStatus };

const STARTUP_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const RELEASES_URL = "https://github.com/band-app/band/releases";
const RELEASE_NOTES_MAX_CHARS = 600;

/**
 * Whether the updater is enabled at runtime. `electron-updater` refuses to
 * run in unpacked dev ("skip checkForUpdates because application is not
 * packed"), and local electron-builder DMGs are signed the same way CI
 * builds are, so `app.isPackaged` is the boundary. Callers pass it in so
 * this module does not import electron eagerly.
 */
export function isUpdaterEnabled(isPackaged: boolean): boolean {
  return isPackaged;
}

/** The subset of electron-updater's `UpdateInfo` the toast shows. */
export interface UpdateInfoLike {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
}

/**
 * The subset of the `electron-updater` `AppUpdater` interface we use. Tests
 * inject a fake satisfying this; production passes the live singleton.
 *
 * `checkForUpdates` resolves with the feed's latest release (`null` when the
 * updater is inactive) and rejects on failure. `downloadUpdate` resolves
 * once the update is downloaded and verified, and rejects on failure. Both
 * also emit `error`, which must have a listener: an EventEmitter throws on
 * an unhandled `error` event.
 */
export interface UpdaterLike {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: UpdateInfoLike } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
}

/**
 * Pick the `autoUpdater` singleton out of an `import()`ed electron-updater
 * module.
 *
 * `electron-updater` is CJS and exposes `autoUpdater` through a lazy getter
 * on `module.exports`. Node's dynamic-`import()` interop does not hoist
 * getter-defined properties onto the namespace's named exports, so
 * `mod.autoUpdater` is `undefined` and only `mod.default.autoUpdater` works.
 * Every DMG up to v0.5.3 read the named export and failed on "Check for
 * Updates…". We try `.default.autoUpdater` first, fall back to
 * `.autoUpdater`, and throw a clear message when neither resolves.
 */
export function pickAutoUpdater(mod: unknown): UpdaterLike {
  const m = mod as { default?: { autoUpdater?: unknown }; autoUpdater?: unknown };
  const candidate = m.default?.autoUpdater ?? m.autoUpdater;
  if (!candidate) {
    throw new Error(
      "electron-updater did not expose autoUpdater singleton " +
        "(checked mod.default.autoUpdater and mod.autoUpdater)",
    );
  }
  return candidate as UpdaterLike;
}

async function loadDefaultUpdater(): Promise<UpdaterLike> {
  const mod = await import("electron-updater");
  return pickAutoUpdater(mod);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/**
 * Turn the feed's release notes into short plain text for the toast. The
 * GitHub provider returns the release body as HTML (a `<ul>` of commit
 * subjects for our releases). The toast renders text, never HTML, so a
 * release body can't inject markup into the dashboard.
 */
function releaseNotesToText(notes: UpdateInfoLike["releaseNotes"]): string | null {
  if (!notes) return null;
  const raw = Array.isArray(notes) ? notes.map((n) => n.note ?? "").join("\n") : notes;
  const text = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|li|h[1-6]|div|ul|ol)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, name: string) => ENTITIES[name] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  if (!text) return null;
  if (text.length <= RELEASE_NOTES_MAX_CHARS) return text;
  return `${text.slice(0, RELEASE_NOTES_MAX_CHARS).trimEnd()}…`;
}

function releaseUrlFor(version: string): string {
  return `${RELEASES_URL}/tag/v${encodeURIComponent(version)}`;
}

export interface UpdateControllerOptions {
  /** The running app version (`app.getVersion()`). */
  currentVersion: string;
  /** Called with every status change. The bootstrap broadcasts it. */
  onStatus: (status: UpdateStatus) => void;
  /** Defaults to the live electron-updater singleton. */
  loadUpdater?: () => Promise<UpdaterLike>;
  /** Defaults to `updater.quitAndInstall()`. */
  restart?: (updater: UpdaterLike) => void;
  /** Clock for the wake-from-sleep staleness check. */
  now?: () => number;
}

export class UpdateController {
  private status: UpdateStatus = { state: "idle" };
  private updater: UpdaterLike | null = null;
  private checkInFlight: Promise<void> | null = null;
  private checkUserInitiated = false;
  private downloadInFlight: Promise<void> | null = null;
  /** The release the last successful check found, kept for download retries. */
  private release: UpdateRelease | null = null;
  private downloaded: UpdateRelease | null = null;
  /** A background check that finds this version again stays silent. */
  private dismissedVersion: string | null = null;
  private lastCheckAt = 0;
  private readonly opts: UpdateControllerOptions;

  constructor(opts: UpdateControllerOptions) {
    this.opts = opts;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * Check the feed. A user-initiated check reports every step; a background
   * check changes the status only when it finds an update the user has not
   * dismissed. A check requested while another is in flight joins it, and a
   * user-initiated one upgrades the running check so its result is shown.
   */
  check(opts: { userInitiated: boolean }): Promise<void> {
    if (this.downloaded || this.downloadInFlight) {
      // The update is already downloading or waiting for a restart. Asking
      // again brings the toast back instead of checking a second time.
      if (opts.userInitiated) {
        this.dismissedVersion = null;
        this.setStatus(this.downloadedOrDownloadingStatus());
      }
      return this.downloadInFlight ?? Promise.resolve();
    }
    if (this.checkInFlight) {
      if (opts.userInitiated && !this.checkUserInitiated) {
        this.checkUserInitiated = true;
        this.setStatus({ state: "checking", userInitiated: true });
      }
      return this.checkInFlight;
    }
    this.checkUserInitiated = opts.userInitiated;
    this.checkInFlight = this.runCheck().finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  /** Download the release the last check found. */
  async download(): Promise<void> {
    if (this.downloadInFlight) return this.downloadInFlight;
    if (this.checkInFlight) await this.checkInFlight;
    const release = this.release;
    const s = this.status;
    const canDownload = s.state === "available" || (s.state === "error" && s.phase === "download");
    if (!release || !canDownload) return;
    this.downloadInFlight = this.runDownload(release).finally(() => {
      this.downloadInFlight = null;
    });
    return this.downloadInFlight;
  }

  /** Quit and install the downloaded update. */
  restart(): void {
    if (!this.downloaded || !this.updater) return;
    log.info({ version: this.downloaded.version }, "restarting to install");
    if (this.opts.restart) {
      this.opts.restart(this.updater);
    } else {
      // Closes all windows, fires `before-quit`, then installs and relaunches.
      this.updater.quitAndInstall();
    }
  }

  /** The user closed the toast. */
  dismiss(): void {
    const s = this.status;
    if (s.state === "checking" || s.state === "downloading") return;
    if (s.state === "available" || s.state === "downloaded") {
      this.dismissedVersion = s.version;
    }
    this.setStatus({ state: "idle" });
  }

  /**
   * Schedule background checks: one `startupDelayMs` after the call, then
   * every `intervalMs`. Returns a function that cancels both timers.
   */
  start(opts: { startupDelayMs?: number; intervalMs?: number } = {}): () => void {
    const background = () => {
      void this.check({ userInitiated: false });
    };
    const startup = setTimeout(background, opts.startupDelayMs ?? STARTUP_CHECK_DELAY_MS);
    const interval = setInterval(background, opts.intervalMs ?? CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(startup);
      clearInterval(interval);
    };
  }

  /**
   * Run a background check when the last one started more than `maxAgeMs`
   * ago. Timers don't advance while a Mac sleeps, so the bootstrap calls this
   * on wake to catch up on checks the interval missed.
   */
  checkIfStale(maxAgeMs = CHECK_INTERVAL_MS): void {
    const now = this.opts.now?.() ?? Date.now();
    if (now - this.lastCheckAt < maxAgeMs) return;
    void this.check({ userInitiated: false });
  }

  private async runCheck(): Promise<void> {
    this.lastCheckAt = this.opts.now?.() ?? Date.now();
    if (this.checkUserInitiated) {
      this.setStatus({ state: "checking", userInitiated: true });
    }
    try {
      const updater = await this.getUpdater();
      const result = await updater.checkForUpdates();
      const info = result?.updateInfo;
      const available =
        !!result &&
        !!info &&
        (result.isUpdateAvailable ?? info.version !== this.opts.currentVersion);
      if (available && info) {
        const release = this.toRelease(info);
        this.release = release;
        log.info(
          { version: release.version, userInitiated: this.checkUserInitiated },
          "update available",
        );
        if (this.checkUserInitiated) {
          this.dismissedVersion = null;
        } else if (this.dismissedVersion === release.version) {
          return;
        }
        this.setStatus({ state: "available", ...release });
        return;
      }
      log.info({ userInitiated: this.checkUserInitiated }, "no update available");
      this.release = null;
      if (this.checkUserInitiated) {
        this.setStatus({
          state: "up-to-date",
          currentVersion: this.opts.currentVersion,
          userInitiated: true,
        });
      } else if (this.status.state === "available") {
        // The release we were offering is gone from the feed.
        this.setStatus({ state: "idle" });
      }
    } catch (err) {
      const message = errorMessage(err);
      log.error({ err: message, userInitiated: this.checkUserInitiated }, "check failed");
      if (this.checkUserInitiated) {
        this.setStatus({ state: "error", message, phase: "check", userInitiated: true });
      }
    }
  }

  private async runDownload(release: UpdateRelease): Promise<void> {
    this.setStatus({ state: "downloading", percent: 0, ...release });
    try {
      const updater = await this.getUpdater();
      await updater.downloadUpdate();
      log.info({ version: release.version }, "update downloaded");
      this.downloaded = release;
      this.setStatus({ state: "downloaded", ...release });
    } catch (err) {
      const message = errorMessage(err);
      log.error({ err: message, version: release.version }, "download failed");
      this.setStatus({ state: "error", message, phase: "download", userInitiated: true });
    }
  }

  private downloadedOrDownloadingStatus(): UpdateStatus {
    if (this.downloaded) return { state: "downloaded", ...this.downloaded };
    if (this.status.state === "downloading") return this.status;
    // `downloadInFlight` is set, so `release` is the one downloading.
    return { state: "downloading", percent: 0, ...(this.release as UpdateRelease) };
  }

  private async getUpdater(): Promise<UpdaterLike> {
    if (this.updater) return this.updater;
    const updater = await (this.opts.loadUpdater ?? loadDefaultUpdater)();
    // The toast drives the download. A downloaded update still installs on
    // quit when the user never clicks "Restart to update".
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.on("download-progress", (info) => {
      const s = this.status;
      if (s.state !== "downloading") return;
      const percent = Math.floor(info.percent);
      if (percent === s.percent) return;
      this.setStatus({ ...s, percent });
    });
    updater.on("error", (err) => {
      // Failures reach us through the rejected promises above. This listener
      // exists so the emitter doesn't throw on an unhandled `error` event.
      log.warn({ err: err.message }, "electron-updater error event");
    });
    this.updater = updater;
    return updater;
  }

  private toRelease(info: UpdateInfoLike): UpdateRelease {
    return {
      version: info.version,
      currentVersion: this.opts.currentVersion,
      releaseName: info.releaseName ?? null,
      releaseNotes: releaseNotesToText(info.releaseNotes),
      releaseUrl: releaseUrlFor(info.version),
    };
  }

  private setStatus(next: UpdateStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.opts.onStatus(next);
  }
}

const ERROR_MESSAGE_MAX_CHARS = 500;

/** electron-updater errors can carry a whole HTTP response body. */
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.length <= ERROR_MESSAGE_MAX_CHARS) return message;
  return `${message.slice(0, ERROR_MESSAGE_MAX_CHARS).trimEnd()}…`;
}
