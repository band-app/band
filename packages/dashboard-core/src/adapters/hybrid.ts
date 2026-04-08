import type { PlatformCapabilities, Unsubscribe } from "../adapter";
import { toWorkspaceId } from "../lib/workspace-id";
import type { AppMode } from "../types";
import { WebCapabilities, WebDashboardAdapter } from "./web";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}

/**
 * Hybrid adapter: data operations go through HTTP (WebDashboardAdapter),
 * but workspace open and active-workspace tracking use Tauri IPC when
 * running inside the Tauri webview in side-panel mode.
 *
 * In full-editor mode, workspace clicks navigate to in-app routes instead
 * of opening external IDE windows.
 */
export class HybridDashboardAdapter extends WebDashboardAdapter {
  private _appMode: AppMode = "side-panel";

  setAppMode(mode: AppMode) {
    this._appMode = mode;
  }

  get appMode(): AppMode {
    return this._appMode;
  }

  async removeWorkspace(project: string, branch: string): Promise<void> {
    if (isTauri() && this._appMode === "side-panel") {
      const workspaceId = toWorkspaceId(project, branch);
      await tauriInvoke("workspace_close", { workspaceId });
    }
    return super.removeWorkspace(project, branch);
  }

  async closeWorkspaceWindows(workspaceId: string): Promise<void> {
    if (isTauri() && this._appMode === "side-panel") {
      await tauriInvoke("workspace_close", { workspaceId });
    }
  }

  async openWorkspace(workspaceId: string): Promise<void> {
    if (isTauri() && this._appMode === "side-panel") {
      await tauriInvoke("workspace_focus", { workspaceId });
      return;
    }
    return super.openWorkspace(workspaceId);
  }

  subscribeActiveWorkspace(onChange: (workspaceId: string | null) => void): Unsubscribe {
    if (!isTauri() || this._appMode === "full-editor") {
      return super.subscribeActiveWorkspace(onChange);
    }

    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const wsId = await tauriInvoke<string | null>("get_active_workspace");
        onChange(wsId);
      } catch {
        // ignore
      }

      const unlisten = await tauriListen<string>("active-workspace", (payload) => {
        onChange(payload);
      });

      cleanup = unlisten;
    })();

    return () => cleanup?.();
  }
}

/**
 * Native shell capabilities: Tauri IPC for native OS features
 * (copy path, reveal in finder, pick folder, open URL).
 * Tunnel and web server management are handled via HTTP endpoints.
 *
 * Mode-aware: in side-panel mode, workspace clicks focus IDE windows.
 * In full-editor mode, workspace clicks navigate to in-app routes.
 */
export class NativeShellCapabilities implements PlatformCapabilities {
  private web = new WebCapabilities();
  private _appMode: AppMode = "side-panel";
  navigate?: (href: string) => void;

  setAppMode(mode: AppMode) {
    this._appMode = mode;
  }

  get appMode(): AppMode {
    return this._appMode;
  }

  get copyPath(): boolean {
    return isTauri();
  }

  getWorkspaceHref(workspaceId: string): string | undefined {
    // In side-panel mode inside Tauri, clicking a workspace should focus
    // the IDE window via openWorkspace (Tauri IPC), not navigate.
    // In full-editor mode, navigate to the workspace page in-app.
    if (isTauri() && this._appMode === "side-panel") return undefined;
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
