import type { PlatformCapabilities, Unsubscribe } from "../adapter";
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

  // ---- Background app-update banner (see updater.ts) -----------------------
  // The web adapter intentionally omits these so a plain browser tab never
  // sees the banner (the hook short-circuits to "none" when the adapter
  // method is undefined). Only the desktop shell can drive electron-updater.

  /** Read the current pending update, if any. Used by the hook on mount to
   *  catch the race where the renderer mounts after the startup check
   *  already populated main-process state. */
  async getUpdateStatus(): Promise<{ version: string } | null> {
    return desktopInvoke<{ version: string } | null>("updater_status");
  }

  /** Kick off the download + install. On success the OS quits the process,
   *  so this promise typically never resolves in production. */
  async installUpdate(): Promise<void> {
    await desktopInvoke<void>("updater_install");
  }

  /** Subscribe to `updater-status-changed` events emitted by the main
   *  process. Returns the unlisten. Throws if called outside the shell —
   *  callers should gate on `getUpdateStatus` being defined first. */
  subscribeUpdateStatus(cb: (pending: { version: string } | null) => void): Unsubscribe {
    const bridge = electronBridge();
    if (!bridge) {
      // The hook guards on the method being defined, but if for some reason
      // this is called outside the shell, fail loud rather than silently.
      throw new Error("subscribeUpdateStatus called outside the desktop shell");
    }
    return bridge.on("updater-status-changed", (payload) =>
      cb(payload as { version: string } | null),
    );
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
