import type { PlatformCapabilities } from "../adapter";
import { WebCapabilities, WebDashboardAdapter } from "./web";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Tauri-flavoured dashboard adapter.
 *
 * Identical to the web adapter except for `installCli`, which falls back to
 * the macOS admin password dialog when the web server reports
 * "elevation-required". The Tauri app is the foreground GUI process, so it
 * can show the dialog reliably; the web server cannot.
 */
export class TauriDashboardAdapter extends WebDashboardAdapter {
  async installCli(opts?: { allowPrompt?: boolean }): Promise<void> {
    try {
      // Try the web server path first (works when /usr/local/bin is writable).
      await super.installCli();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If elevation is needed and the user explicitly clicked Install, defer
      // to the desktop app's admin-password dialog.
      if (opts?.allowPrompt && isTauri() && message.includes("elevation-required")) {
        const paths = await this.trpc.cli.resolve.query();
        if (!paths) {
          throw new Error(
            "Could not find band CLI binary. Build it first with: cargo build --release -p band-cli",
          );
        }
        await tauriInvoke("install_cli", {
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
 * Native shell capabilities: thin wrappers over Tauri-only OS features
 * (copy path, reveal in Finder, pick folder, open URL). Workspace navigation
 * always goes through `WebCapabilities.getWorkspaceHref` — there is no
 * mode-aware branching anymore.
 */
export class NativeShellCapabilities implements PlatformCapabilities {
  private web = new WebCapabilities();
  navigate?: (href: string) => void;

  get copyPath(): boolean {
    return isTauri();
  }

  getWorkspaceHref(workspaceId: string): string | undefined {
    return this.web.getWorkspaceHref(workspaceId);
  }

  async revealInFinder(path: string): Promise<void> {
    if (!isTauri()) return;
    await tauriInvoke("reveal_in_finder", { path });
  }

  async pickFolder(): Promise<string | null> {
    if (!isTauri()) return null;
    return tauriInvoke<string | null>("pick_folder");
  }

  async openUrl(url: string): Promise<void> {
    if (!isTauri()) {
      window.open(url, "_blank");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  }
}
