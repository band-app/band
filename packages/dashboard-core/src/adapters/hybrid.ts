import type { PlatformCapabilities, Unsubscribe } from "../adapter";
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
 * running inside the Tauri webview.
 */
export class HybridDashboardAdapter extends WebDashboardAdapter {
  async openWorkspace(workspaceId: string): Promise<void> {
    if (isTauri()) {
      await tauriInvoke("workspace_focus", { workspaceId });
      return;
    }
    return super.openWorkspace(workspaceId);
  }

  subscribeActiveWorkspace(onChange: (workspaceId: string | null) => void): Unsubscribe {
    if (!isTauri()) {
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
 */
export class NativeShellCapabilities implements PlatformCapabilities {
  private web = new WebCapabilities();

  get copyPath(): boolean {
    return isTauri();
  }

  getWorkspaceHref(workspaceId: string): string | undefined {
    // Inside Tauri, clicking a workspace should focus the IDE window
    // via openWorkspace (Tauri IPC), not navigate to the chat page.
    if (isTauri()) return undefined;
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
