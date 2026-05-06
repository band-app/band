import type { PlatformCapabilities } from "../adapter";
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
          throw new Error(
            "Could not find band CLI binary. Build it first with: cargo build --release -p band-cli",
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

  async openUrl(url: string): Promise<void> {
    if (!isDesktopShell()) {
      window.open(url, "_blank");
      return;
    }
    await desktopInvoke("open_external", { url });
  }
}
