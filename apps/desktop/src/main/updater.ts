/**
 * Auto-updater. Direct port of
 * `apps/dashboard/src-tauri/src/commands/updater.rs`, backed by
 * `electron-updater` instead of `tauri-plugin-updater`.
 *
 * Parity goals (issue #363):
 *   - Boot-time silent check: 10s after launch, mirroring the
 *     `tokio::time::sleep(Duration::from_secs(10))` in lib.rs::run.
 *   - Interactive "Check for Updates…" menu item: dialog when up-to-date,
 *     dialog with Update/Later when an update exists, progress reporting
 *     during download, restart on install.
 *   - Same UPDATER_ENABLED gating: only active in CI release builds.
 *
 * Why electron-updater (not Squirrel.Mac directly): it shares the
 * publish/feed semantics with `electron-builder`, generates the
 * `app-update.yml` manifest baked into the .app, and matches the GitHub
 * Releases hosting we already use. The legacy `latest.json` (minisign-signed,
 * Tauri-format) stays in the same release for users still on the Tauri shell.
 *
 * The publish endpoint itself is configured in `electron-builder.yml`; the
 * runtime simply calls `autoUpdater.checkForUpdates()` and reads the feed
 * from the bundled `app-update.yml`.
 *
 * Implementation note — lazy electron imports: the top of this file
 * deliberately avoids importing `electron` or `electron-updater` eagerly.
 * Both packages bind to the running Electron binary at module-load time,
 * so a plain `node` process loading `updater.ts` (e.g. our integration
 * tests) would either get back `undefined` exports (in electron's case
 * `index.js` returns a path string) or hard-fail (in electron-updater's
 * case it imports `electron`). The runtime defaults are resolved inside
 * the helper functions; tests inject a `CheckForUpdateDeps` and never
 * touch the live modules.
 */

// Type-only imports erase at compile time — these don't trigger module
// loading at runtime, even under plain Node.
import type { BrowserWindow } from "electron";
import { createLogger } from "./services/log.js";

const log = createLogger("updater");

/**
 * The "we've seen a newer version" carrier shared between the background
 * periodic check, the main-process broadcast layer, and the renderer banner.
 * `null` means no update is currently known to be available.
 */
export type PendingUpdate = { version: string } | null;

/**
 * Module-scoped single-flight guards. The `electron-updater` singleton has
 * one set of listeners shared across all callers, so a second invocation
 * while a check or install is in flight would cross-wire listener teardowns.
 *
 * The guards return immediately (no-op) when something is already running,
 * which is the right semantics for both the background loop firing while
 * an install is downloading and for a double-clicked Install button.
 *
 * Visible for tests (`__resetUpdaterGuardsForTests`) so a process-level
 * mutex doesn't leak state across the test suite's back-to-back cases.
 */
let inFlightCheck = false;
let inFlightInstall = false;

export function __resetUpdaterGuardsForTests(): void {
  inFlightCheck = false;
  inFlightInstall = false;
}

/**
 * Whether the updater is enabled at runtime.
 *
 * Tauri gated this on `option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some()`,
 * a compile-time check that baked a boolean into the binary. The first port
 * to Electron mirrored that with a `process.env.BAND_UPDATER_ENABLED` read
 * — which is wrong, because env variables exported during the CI build
 * step do not survive into the user's launch environment, so the flag was
 * always `false` in shipped DMGs and the auto-updater never fired.
 *
 * Replacement: gate purely on `app.isPackaged`. `electron-updater` itself
 * refuses to run in unpacked dev (logs "skip checkForUpdates because
 * application is not packed"), and our local electron-builder dev DMGs go
 * through code-signing the same way CI builds do, so the packaged check
 * is the right boundary. Callers pass `app.isPackaged` in (so this module
 * doesn't need to import electron eagerly — see file-header note).
 */
export function isUpdaterEnabled(isPackaged: boolean): boolean {
  return isPackaged;
}

/**
 * The subset of the `electron-updater` `AppUpdater` interface we use. Tests
 * inject a fake satisfying this; production code passes the live singleton.
 */
export interface UpdaterLike {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "update-available", listener: (info: { version: string }) => void): void;
  on(event: "update-not-available", listener: () => void): void;
  on(event: "download-progress", listener: (info: ProgressInfo) => void): void;
  on(event: "update-downloaded", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
}

interface ProgressInfo {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

/**
 * Visible for tests. The default updater is the singleton from
 * electron-updater; tests pass a fake to avoid touching the network.
 */
export interface CheckForUpdateDeps {
  updater?: UpdaterLike;
  /** Window to parent dialogs to. Falls back to no-parent dialogs. */
  parentWindow?: BrowserWindow | null;
  /** Override `autoUpdater.quitAndInstall` (used by interactive flow tests). */
  restart?: () => void;
  /** Override the info dialog (used in tests). */
  showInfo?: (title: string, message: string) => Promise<void>;
  /**
   * Override the confirm dialog. Resolves true when the user clicks
   * "Update", false otherwise.
   */
  showConfirm?: (title: string, message: string) => Promise<boolean>;
}

const ZERO_DEPS: Readonly<CheckForUpdateDeps> = Object.freeze({});

/**
 * Pick the `autoUpdater` singleton out of an `import()`ed electron-updater
 * module. Exported for tests — see notes below for the bug it documents.
 *
 * `electron-updater` is CJS and exposes its `autoUpdater` singleton via a
 * lazy CJS getter:
 *
 *   Object.defineProperty(exports, "autoUpdater", {
 *     get: () => _autoUpdater ?? doLoadAutoUpdater(),
 *   });
 *
 * Node's dynamic-`import()` ESM⇄CJS interop does NOT hoist getter-defined
 * properties onto the namespace's named exports. They're reachable only
 * through `.default` (which IS the entire `module.exports`). So
 * `mod.autoUpdater` resolves to `undefined`, and downstream code blows up
 * with "Cannot set properties of undefined (setting 'autoDownload')" —
 * which is exactly what every shipped DMG up to v0.5.3 did when the user
 * clicked "Check for Updates…".
 *
 * We try `.default.autoUpdater` first, fall back to `.autoUpdater` for
 * any future bundler / interop combo that does hoist it, and throw with a
 * clear message if neither resolves so the existing `checkForUpdate`
 * try/catch can surface the failure as a dialog instead of leaving the
 * user clicking into the void.
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

/**
 * Lazy-load the live `electron-updater` singleton. Only called when no
 * `deps.updater` was supplied — i.e. in production. Tests inject a fake
 * via `deps.updater` and never reach this.
 */
async function loadDefaultUpdater(): Promise<UpdaterLike> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = await import("electron-updater");
  return pickAutoUpdater(mod);
}

async function loadElectron(): Promise<typeof import("electron")> {
  return import("electron");
}

async function defaultShowInfo(
  parent: BrowserWindow | null,
  title: string,
  message: string,
): Promise<void> {
  const { dialog } = await loadElectron();
  const opts = {
    type: "info" as const,
    title,
    message,
    buttons: ["OK"],
    defaultId: 0,
  };
  if (parent) {
    await dialog.showMessageBox(parent, opts);
  } else {
    await dialog.showMessageBox(opts);
  }
}

async function defaultShowConfirm(
  parent: BrowserWindow | null,
  title: string,
  message: string,
): Promise<boolean> {
  const { dialog } = await loadElectron();
  const opts = {
    type: "question" as const,
    title,
    message,
    buttons: ["Update", "Later"],
    defaultId: 0,
    cancelId: 1,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  return result.response === 0;
}

/**
 * Check for updates and prompt the user to install if one is available.
 *
 * When `interactive` is true, a dialog is shown even when no update is found
 * (used for the "Check for Updates…" menu item). When false, the check is
 * silent unless an update exists (used for the automatic startup check).
 *
 * Mirror of `commands::updater::check_for_update` in updater.rs. The control
 * flow there is request/response (`updater.check().await` returns the update
 * descriptor); electron-updater is event-driven, so we wire one-shot
 * listeners and bridge them back to the same linear flow here.
 */
export async function checkForUpdate(
  interactive: boolean,
  deps: CheckForUpdateDeps = ZERO_DEPS,
): Promise<void> {
  const parent = deps.parentWindow ?? null;
  const showInfo = deps.showInfo ?? ((t, m) => defaultShowInfo(parent, t, m));
  const showConfirm = deps.showConfirm ?? ((t, m) => defaultShowConfirm(parent, t, m));

  // Share the check guard with `checkForUpdateBackground` — both touch the
  // same `electron-updater` listener bus. If a background tick or another
  // menu click is already in flight, no-op rather than cross-wiring events.
  if (inFlightCheck) {
    log.info("check already in flight, skipping");
    if (interactive) {
      await showInfo("Checking for Updates", "An update check is already in progress.");
    }
    return;
  }
  inFlightCheck = true;
  try {
    let updater: UpdaterLike;
    try {
      updater = deps.updater ?? (await loadDefaultUpdater());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ err: msg }, "failed to create updater");
      if (interactive) {
        await showInfo("Update Error", `Failed to check for updates: ${msg}`);
      }
      return;
    }

    const result = await performCheck(updater);

    if (result.kind === "error") {
      log.error({ err: result.error.message }, "check failed");
      if (interactive) {
        await showInfo("Update Error", "Failed to check for updates. Please try again later.");
      }
      return;
    }

    if (result.kind === "not-available") {
      log.info("no update available");
      if (interactive) {
        await showInfo("No Updates Available", "You're running the latest version of Band.");
      }
      return;
    }

    const { version } = result;
    log.info({ version }, "update available");

    const accepted = await showConfirm(
      "Update Available",
      `Band v${version} is available. Would you like to download and install it now?`,
    );
    if (!accepted) {
      return;
    }

    const installed = await performDownload(updater);

    if (!installed.ok) {
      log.error({ err: installed.error.message }, "install failed");
      await showInfo("Update Failed", `Failed to install the update: ${installed.error.message}`);
      return;
    }

    log.info({ version }, "installed, restarting");
    if (deps.restart) {
      deps.restart();
    } else {
      // electron-updater's quitAndInstall handles the relaunch flow. It
      // closes all windows, fires `before-quit`, then runs the installer.
      updater.quitAndInstall();
    }
  } finally {
    inFlightCheck = false;
  }
}

/**
 * Shared check-phase helper used by both `checkForUpdate` (menu / dialog path)
 * and `checkForUpdateBackground` (banner path). Drives a single
 * `checkForUpdates()` round-trip and bridges the event-based result back to
 * a linear value. Always tears down its listeners before returning.
 */
type CheckOutcome =
  | { kind: "available"; version: string }
  | { kind: "not-available" }
  | { kind: "error"; error: Error };

async function performCheck(updater: UpdaterLike): Promise<CheckOutcome> {
  // We drive the download + install ourselves so the caller can decide whether
  // to confirm via dialog (interactive) or via in-app banner (background).
  // With `autoDownload=false`, electron-updater emits `update-available` and
  // stops; we then call `downloadUpdate()` later if the caller proceeds.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  try {
    return await new Promise<CheckOutcome>((resolve) => {
      let settled = false;
      const settle = (o: CheckOutcome) => {
        if (settled) return;
        settled = true;
        resolve(o);
      };

      updater.on("update-available", (info) => {
        settle({ kind: "available", version: info.version });
      });
      updater.on("update-not-available", () => {
        settle({ kind: "not-available" });
      });
      updater.on("error", (err) => {
        settle({ kind: "error", error: err });
      });

      Promise.resolve(updater.checkForUpdates()).catch((err) => {
        settle({
          kind: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    });
  } finally {
    // Tear the check-phase listeners down so a second invocation doesn't
    // double-fire, and so the download phase below can re-wire `error`.
    updater.removeAllListeners("update-available");
    updater.removeAllListeners("update-not-available");
    updater.removeAllListeners("error");
  }
}

/** Shared download-phase helper used by `checkForUpdate` and
 *  `installPendingUpdate`. Drives `downloadUpdate()`, logs progress ticks,
 *  resolves on `update-downloaded` / `error`. Listener teardown is
 *  guaranteed via the `finally` block. */
async function performDownload(
  updater: UpdaterLike,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  try {
    return await new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => {
      let settled = false;
      const settle = (r: { ok: true } | { ok: false; error: Error }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      updater.on("download-progress", (info) => {
        // electron-updater emits at a sensible interval (~every few hundred
        // ms) so we just forward to the log.
        const transferred = Math.round(info.transferred);
        const total = Math.round(info.total);
        const pct = info.percent.toFixed(1);
        log.info({ transferred, total, pct }, "progress");
      });
      updater.on("update-downloaded", () => {
        log.info("download finished, installing");
        settle({ ok: true });
      });
      updater.on("error", (err) => {
        settle({ ok: false, error: err });
      });

      Promise.resolve(updater.downloadUpdate()).catch((err) => {
        settle({
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    });
  } finally {
    updater.removeAllListeners("download-progress");
    updater.removeAllListeners("update-downloaded");
    updater.removeAllListeners("error");
  }
}

/**
 * Silent check used by the background path (startup + 2h periodic). Returns
 * the available `{ version }` or `null`. Never shows a dialog. The renderer
 * is notified separately via `broadcastUpdaterStatus` in the bootstrap.
 *
 * Shares the `inFlightCheck` mutex with `checkForUpdate`, so a menu-click
 * mid-periodic-tick can't cross-fire listeners on the shared singleton.
 */
export async function checkForUpdateBackground(
  deps: CheckForUpdateDeps = ZERO_DEPS,
): Promise<PendingUpdate> {
  if (inFlightCheck) {
    log.info("background check skipped (check already in flight)");
    return null;
  }
  inFlightCheck = true;
  try {
    let updater: UpdaterLike;
    try {
      updater = deps.updater ?? (await loadDefaultUpdater());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ err: msg }, "failed to create updater (background)");
      return null;
    }

    const result = await performCheck(updater);
    if (result.kind === "available") {
      log.info({ version: result.version }, "background check found update");
      return { version: result.version };
    }
    if (result.kind === "error") {
      log.error({ err: result.error.message }, "background check failed");
    } else {
      log.info("background check: no update");
    }
    return null;
  } finally {
    inFlightCheck = false;
  }
}

/**
 * Download + install a pending update without any dialogs. Invoked from the
 * IPC handler when the user clicks the in-app banner's Install button.
 *
 * Single-flight: a second click while a download is in flight is a no-op.
 * The renderer also disables its button optimistically, but a stray invoke
 * from another window would otherwise re-enter and cross-wire listeners.
 *
 * On success, calls `updater.quitAndInstall()` (or the test `restart`
 * override), which terminates the process — anything after that point
 * never runs in production.
 */
export async function installPendingUpdate(deps: CheckForUpdateDeps = ZERO_DEPS): Promise<void> {
  if (inFlightInstall) {
    log.info("install already in flight, skipping");
    return;
  }
  inFlightInstall = true;
  try {
    let updater: UpdaterLike;
    try {
      updater = deps.updater ?? (await loadDefaultUpdater());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ err: msg }, "failed to create updater (install)");
      throw e instanceof Error ? e : new Error(msg);
    }
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;

    const installed = await performDownload(updater);
    if (!installed.ok) {
      log.error({ err: installed.error.message }, "install failed");
      throw installed.error;
    }

    log.info("install complete, restarting");
    if (deps.restart) {
      deps.restart();
      return;
    }
    updater.quitAndInstall();
  } finally {
    inFlightInstall = false;
  }
}

/**
 * Schedule the boot-time silent check. Mirrors the
 * `tokio::time::sleep(Duration::from_secs(10))` in lib.rs::run: hold off
 * 10s after launch so the dashboard is fully loaded before we hit the
 * network.
 *
 * Returns a cancellation function so the caller can abort the pending check
 * during shutdown (avoids a stray banner state flip after Cmd+Q).
 *
 * `isPackaged` is supplied by the caller (typically `app.isPackaged`) so
 * this module doesn't need to import `electron` eagerly. `delayMs` is
 * overridable for tests; production always uses the 10s default to match
 * the legacy Tauri shell.
 *
 * Background mode: this used to call the interactive `checkForUpdate` which
 * popped OS dialogs to confirm download. The flow is now a silent
 * `checkForUpdateBackground`; the result is fed to `opts.onResult` so the
 * bootstrap can broadcast it to the renderer banner.
 */
export function scheduleStartupCheck(
  isPackaged: boolean,
  opts: CheckForUpdateDeps & {
    delayMs?: number;
    onResult?: (pending: PendingUpdate) => void;
  } = {},
): () => void {
  // Skip in unpacked dev runs — electron-updater refuses to operate
  // without a packaged `app-update.yml` and would log a confusing warning
  // on every launch.
  if (!isUpdaterEnabled(isPackaged)) {
    return () => undefined;
  }

  const handle = setTimeout(() => {
    void checkForUpdateBackground(opts)
      .then((pending) => opts.onResult?.(pending))
      .catch((err) => {
        log.error({ err: String(err) }, "startup check threw");
      });
  }, opts.delayMs ?? 10_000);

  return () => clearTimeout(handle);
}

/**
 * Periodic background update check. Fires every `intervalMs` (default 2h)
 * starting `intervalMs` after the call (it does NOT fire immediately — the
 * 10s startup check already covered that). Each tick runs
 * `checkForUpdateBackground` and forwards the result to `opts.onResult`,
 * which the bootstrap uses to update state + broadcast to the renderer.
 *
 * No-op in unpacked dev (mirrors `scheduleStartupCheck`).
 *
 * Returns a cancellation function — call it in `cleanupOnce` so the
 * interval doesn't outlive the process.
 */
export function schedulePeriodicCheck(
  isPackaged: boolean,
  opts: CheckForUpdateDeps & {
    intervalMs?: number;
    onResult?: (pending: PendingUpdate) => void;
  } = {},
): () => void {
  if (!isUpdaterEnabled(isPackaged)) {
    return () => undefined;
  }

  const intervalMs = opts.intervalMs ?? 2 * 60 * 60 * 1000;
  const handle = setInterval(() => {
    void checkForUpdateBackground(opts)
      .then((pending) => opts.onResult?.(pending))
      .catch((err) => {
        log.error({ err: String(err) }, "periodic check threw");
      });
  }, intervalMs);

  return () => clearInterval(handle);
}
