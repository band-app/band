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
import { dashLog } from "./services/log.js";

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
 * Lazy-load the live `electron-updater` singleton. Only called when no
 * `deps.updater` was supplied — i.e. in production. Tests never reach this.
 */
async function loadDefaultUpdater(): Promise<UpdaterLike> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = await import("electron-updater");
  return mod.autoUpdater as unknown as UpdaterLike;
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

  let updater: UpdaterLike;
  try {
    updater = deps.updater ?? (await loadDefaultUpdater());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dashLog(`updater: failed to create updater: ${msg}`);
    if (interactive) {
      await showInfo("Update Error", `Failed to check for updates: ${msg}`);
    }
    return;
  }

  // We drive the download + install ourselves so we can show a confirmation
  // dialog after `update-available` fires (matching Tauri's flow). With
  // `autoDownload=false`, electron-updater emits `update-available` and
  // stops; we then call `downloadUpdate()` after the user confirms.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  // Wire the event listeners against a single CheckForUpdates round-trip,
  // then tear them all down before returning so a second invocation
  // doesn't double-fire.
  type Outcome =
    | { kind: "available"; version: string }
    | { kind: "not-available" }
    | { kind: "error"; error: Error };

  const result = await new Promise<Outcome>((resolve) => {
    let settled = false;
    const settle = (o: Outcome) => {
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

  // We're going to add fresh listeners for the download phase below; clear
  // the check-phase ones first so we don't accidentally re-handle them.
  updater.removeAllListeners("update-available");
  updater.removeAllListeners("update-not-available");
  updater.removeAllListeners("error");

  if (result.kind === "error") {
    dashLog(`updater: check failed: ${result.error.message}`);
    if (interactive) {
      await showInfo("Update Error", "Failed to check for updates. Please try again later.");
    }
    return;
  }

  if (result.kind === "not-available") {
    dashLog("updater: no update available");
    if (interactive) {
      await showInfo("No Updates Available", "You're running the latest version of Band.");
    }
    return;
  }

  const { version } = result;
  dashLog(`updater: update available — v${version}`);

  const accepted = await showConfirm(
    "Update Available",
    `Band v${version} is available. Would you like to download and install it now?`,
  );
  if (!accepted) {
    return;
  }

  dashLog(`updater: downloading v${version}…`);

  const installed = await new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => {
    let settled = false;
    const settle = (r: { ok: true } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    updater.on("download-progress", (info) => {
      // The Tauri version logs every chunk; electron-updater emits at a
      // sensible interval (~every few hundred ms) so we just forward.
      const transferred = Math.round(info.transferred);
      const total = Math.round(info.total);
      const pct = info.percent.toFixed(1);
      dashLog(`updater: progress — ${transferred}/${total} bytes (${pct}%)`);
    });
    updater.on("update-downloaded", () => {
      dashLog("updater: download finished, installing…");
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

  // Same teardown reasoning as above.
  updater.removeAllListeners("download-progress");
  updater.removeAllListeners("update-downloaded");
  updater.removeAllListeners("error");

  if (!installed.ok) {
    dashLog(`updater: install failed: ${installed.error.message}`);
    await showInfo("Update Failed", `Failed to install the update: ${installed.error.message}`);
    return;
  }

  dashLog(`updater: installed v${version}, restarting…`);
  if (deps.restart) {
    deps.restart();
  } else {
    // electron-updater's quitAndInstall handles the relaunch flow. It
    // closes all windows, fires `before-quit`, then runs the installer.
    updater.quitAndInstall();
  }
}

/**
 * Schedule the boot-time silent check. Mirrors the
 * `tokio::time::sleep(Duration::from_secs(10))` in lib.rs::run: hold off
 * 10s after launch so the dashboard is fully loaded before we hit the
 * network.
 *
 * Returns a cancellation function so the caller can abort the pending check
 * during shutdown (avoids a stray dialog popping up after Cmd+Q).
 *
 * `isPackaged` is supplied by the caller (typically `app.isPackaged`) so
 * this module doesn't need to import `electron` eagerly. `delayMs` is
 * overridable for tests; production always uses the 10s default to match
 * Tauri.
 */
export function scheduleStartupCheck(
  isPackaged: boolean,
  deps: CheckForUpdateDeps & { delayMs?: number } = {},
): () => void {
  // Skip in unpacked dev runs — electron-updater refuses to operate
  // without a packaged `app-update.yml` and would log a confusing warning
  // on every launch.
  if (!isUpdaterEnabled(isPackaged)) {
    return () => undefined;
  }

  const handle = setTimeout(() => {
    void checkForUpdate(false, deps).catch((err) => {
      dashLog(`updater: startup check threw: ${String(err)}`);
    });
  }, deps.delayMs ?? 10_000);

  return () => clearTimeout(handle);
}
