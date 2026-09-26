import type { PlatformCapabilities, Unsubscribe, UpdateStatus } from "../adapter";
import { WebCapabilities, WebDashboardAdapter } from "./web";

// ---------------------------------------------------------------------------
// Shell detection — the Electron preload (`apps/desktop/src/preload/index.cts`)
// exposes `window.__BAND_DESKTOP__`. Anything else is a regular browser tab.
// ---------------------------------------------------------------------------

function isElectron(): boolean {
  return typeof window !== "undefined" && "__BAND_DESKTOP__" in window;
}

function isDesktopShell(): boolean {
  return isElectron();
}

interface ElectronBridge {
  invoke(channel: string, args?: unknown): Promise<unknown>;
  /** Subscribe to a main-process event. Returns an unlisten function. The
   *  preload exposes this for any name in its event allowlist. */
  on(event: string, cb: (payload: unknown) => void): () => void;
}

function electronBridge(): ElectronBridge | null {
  if (!isElectron()) return null;
  const bridge = (window as unknown as { __BAND_DESKTOP__?: ElectronBridge }).__BAND_DESKTOP__;
  return bridge ?? null;
}

/**
 * Dispatches an `invoke()` call to the Electron desktop shell. Channel names
 * match the IPC channel registry in
 * `apps/desktop/src/shared/ipc-channels.ts` and are gated by the preload
 * allowlist.
 */
async function desktopInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = electronBridge();
  if (bridge) {
    return (await bridge.invoke(cmd, args)) as T;
  }
  throw new Error(`desktopInvoke('${cmd}') called outside the desktop shell`);
}

/**
 * Desktop-shell-flavoured dashboard adapter.
 *
 * Identical to the web adapter except for `installCli`, which falls back to
 * the macOS admin password dialog when the web server reports
 * "elevation-required". The desktop shell is the foreground GUI process, so
 * it can show the dialog reliably; the web server cannot.
 */
export class DesktopDashboardAdapter extends WebDashboardAdapter {
  /**
   * Delete the profile on the server, then wipe its session partition
   * (cookies, storage, cache) on this Mac so no signed-in session is left
   * behind on disk.
   */
  async removeBrowserProfile(profileId: string): Promise<void> {
    await super.removeBrowserProfile(profileId);
    await desktopInvoke("browser_profile_clear_data", { profileId });
  }

  async installCli(opts?: { allowPrompt?: boolean }): Promise<void> {
    try {
      // Try the web server path first (works when /usr/local/bin is writable).
      await super.installCli();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If elevation is needed and the user explicitly clicked Install, defer
      // to the desktop app's admin-password dialog.
      if (opts?.allowPrompt && isDesktopShell() && message.includes("elevation-required")) {
        const paths = await this.trpc.cli.resolve.query();
        if (!paths) {
          // The tRPC resolver returned null. That can mean the bundled
          // sidecar is genuinely missing on disk, but it can also mean the
          // web server isn't ready or the call timed out — so don't
          // confidently blame a missing file like cli.ts::installCli does.
          throw new Error(
            "Could not resolve CLI binary path - try reinstalling Band or restarting the app",
          );
        }
        await desktopInvoke("install_cli", {
          binaryPath: paths.binaryPath,
          symlinkPath: paths.symlinkPath,
        });
        return;
      }
      throw err;
    }
  }

  // ---- App-update toast (see apps/desktop/src/main/updater.ts) -----------
  // The web adapter omits these, so a plain browser tab never shows the
  // toast. Only the desktop shell can drive electron-updater.

  /** The current status. Read on mount, since the startup check may have
   *  finished before the renderer subscribed. */
  async getUpdateStatus(): Promise<UpdateStatus> {
    return desktopInvoke<UpdateStatus>("updater_status");
  }

  subscribeUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe {
    const bridge = electronBridge();
    if (!bridge) {
      throw new Error("subscribeUpdateStatus called outside the desktop shell");
    }
    return bridge.on("updater-status-changed", (payload) => cb(payload as UpdateStatus));
  }

  async checkForUpdates(): Promise<void> {
    await desktopInvoke<void>("updater_check");
  }

  async downloadUpdate(): Promise<void> {
    await desktopInvoke<void>("updater_download");
  }

  /** Quits the app to install the downloaded update. */
  async restartToUpdate(): Promise<void> {
    await desktopInvoke<void>("updater_restart");
  }

  async dismissUpdate(): Promise<void> {
    await desktopInvoke<void>("updater_dismiss");
  }
}

/**
 * Native-shell capabilities: thin wrappers over the desktop shell's OS
 * features (reveal in Finder, pick folder, open external URL).
 */
export class NativeShellCapabilities implements PlatformCapabilities {
  private web = new WebCapabilities();
  navigate?: (href: string) => void;

  get copyPath(): boolean {
    return isDesktopShell();
  }

  // The desktop window only gets its vibrancy layer on macOS (see
  // `apps/desktop/src/main/window.ts`).
  get translucentSidebar(): boolean {
    return isDesktopShell() && /Mac/.test(navigator.userAgent);
  }

  getWorkspaceHref(workspaceId: string): string | undefined {
    return this.web.getWorkspaceHref(workspaceId);
  }

  async revealInFinder(path: string): Promise<void> {
    if (!isDesktopShell()) return;
    await desktopInvoke("reveal_in_finder", { path });
  }

  async pickFolder(): Promise<string | null> {
    if (!isDesktopShell()) return null;
    return desktopInvoke<string | null>("pick_folder");
  }

  /**
   * Open the OS file picker for the editor's "Open File…" action. The
   * native dialog returns the absolute path; the renderer hands that
   * path to `adapter.readExternalFile` / `adapter.saveExternalFile` for
   * the actual file IO.
   *
   * Only meaningful inside the Electron shell — plain browser tabs can't
   * surface a native dialog that yields an absolute filesystem path, so
   * we return `null` and callers gate the UI on `capabilities.pickFile`
   * being defined (same pattern `pickFolder` uses).
   */
  async pickFile(): Promise<string | null> {
    if (!isDesktopShell()) return null;
    return desktopInvoke<string | null>("pick_file");
  }

  /**
   * Open the OS "Save As" picker and persist `content` to the chosen
   * path. Returns the absolute path (or `null` when the user cancels).
   *
   * Backs the editor's "Save untitled tab" flow — the renderer holds an
   * in-memory buffer until the user picks a destination; this bridge
   * runs the dialog and the write in a single IPC round-trip so the
   * file-system trust boundary stays inside the Electron main process.
   *
   * Only meaningful inside the Electron shell; plain browser tabs return
   * `null` and callers gate the UI on `capabilities.pickSaveFile` being
   * defined (same pattern `pickFile` uses).
   */
  async pickSaveFile(args: {
    content: string;
    defaultName?: string;
    defaultPath?: string;
  }): Promise<string | null> {
    if (!isDesktopShell()) return null;
    return desktopInvoke<string | null>("pick_save_file", {
      content: args.content,
      defaultName: args.defaultName,
      defaultPath: args.defaultPath,
    });
  }

  async openUrl(url: string): Promise<void> {
    if (!isDesktopShell()) {
      window.open(url, "_blank");
      return;
    }
    await desktopInvoke("open_external", { url });
  }
}
