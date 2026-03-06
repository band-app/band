import type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "../adapter";
import type {
  CIStatus,
  GitStatus,
  HooksStatus,
  ProjectInfo,
  Settings,
  WorkspaceStatus,
} from "../types";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  return tauriListen<T>(event, (e) => handler(e.payload));
}

export class TauriDashboardAdapter implements DashboardAdapter {
  async listProjects(): Promise<ProjectInfo[]> {
    return invoke<ProjectInfo[]>("project_list");
  }

  async addProject(path: string, label?: string): Promise<void> {
    const project = await invoke<ProjectInfo>("project_init", { path });
    if (label) {
      await invoke("project_update_label", { name: project.name, label });
    }
  }

  async removeProject(name: string): Promise<void> {
    await invoke("project_remove", { name });
  }

  async reorderProjects(names: string[]): Promise<void> {
    await invoke("project_reorder", { names });
  }

  async updateProjectLabel(name: string, label: string | null): Promise<void> {
    await invoke("project_update_label", { name, label });
  }

  async createWorkspace(project: string, branch: string, base?: string): Promise<void> {
    await invoke("workspace_create", { project, branch, base });
  }

  async removeWorkspace(project: string, branch: string): Promise<void> {
    await invoke("workspace_remove", { project, branch });
  }

  async openWorkspace(workspaceId: string): Promise<void> {
    await invoke("workspace_open", { workspaceId });
  }

  async runScript(path: string, scriptType: string): Promise<void> {
    await invoke("workspace_run_script", { path, scriptType });
  }

  async getSettings(): Promise<Settings> {
    return invoke<Settings>("settings_get");
  }

  async updateSettings(settings: Settings): Promise<void> {
    await invoke("settings_update", { settings });
  }

  subscribeAgentStatus(
    onUpdate: (status: WorkspaceStatus) => void,
    onRemove: (workspaceId: string) => void,
  ): Unsubscribe {
    let cleanup: (() => void) | undefined;

    (async () => {
      invoke("status_watch_start").catch(console.error);

      const unlisten = await listen<{
        kind: "update" | "remove";
        status?: WorkspaceStatus;
        workspaceId?: string;
      }>("agent-status", (payload) => {
        if (payload.kind === "update" && payload.status) {
          onUpdate(payload.status);
        } else if (payload.kind === "remove" && payload.workspaceId) {
          onRemove(payload.workspaceId);
        }
      });

      cleanup = () => {
        unlisten();
        invoke("status_watch_stop").catch(console.error);
      };
    })();

    return () => cleanup?.();
  }

  subscribeActiveWorkspace(
    onChange: (workspaceId: string | null) => void,
  ): Unsubscribe {
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const wsId = await invoke<string | null>("get_active_workspace");
        onChange(wsId);
      } catch {
        // ignore
      }

      const unlisten = await listen<string>("active-workspace", (payload) => {
        onChange(payload);
      });

      cleanup = unlisten;
    })();

    return () => cleanup?.();
  }

  subscribeBranchStatus(
    onGit: (workspaceId: string, git: GitStatus) => void,
    onCI: (workspaceId: string, ci: CIStatus) => void,
  ): Unsubscribe {
    let cleanup: (() => void) | undefined;

    (async () => {
      invoke("branch_status_watch_start").catch(console.error);

      const unlistenGit = await listen<{ workspace_id: string; git: GitStatus }>(
        "branch-git-status",
        (payload) => {
          onGit(payload.workspace_id, payload.git);
        },
      );

      const unlistenCI = await listen<{ workspace_id: string; ci: CIStatus }>(
        "branch-ci-status",
        (payload) => {
          onCI(payload.workspace_id, payload.ci);
        },
      );

      cleanup = () => {
        unlistenGit();
        unlistenCI();
        invoke("branch_status_watch_stop").catch(console.error);
      };
    })();

    return () => cleanup?.();
  }

  async checkHooks(): Promise<HooksStatus> {
    return invoke<HooksStatus>("hooks_check");
  }

  async installHooks(): Promise<void> {
    await invoke("hooks_install");
  }
}

export class TauriCapabilities implements PlatformCapabilities {
  copyPath = true;

  async revealInFinder(path: string): Promise<void> {
    await invoke("reveal_in_finder", { path });
  }

  async pickFolder(): Promise<string | null> {
    return invoke<string | null>("pick_folder");
  }

  async openUrl(url: string): Promise<void> {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  }

  tunnel = {
    async check(): Promise<boolean> {
      return invoke<boolean>("tunnel_check");
    },
    async start(): Promise<void> {
      await invoke("tunnel_start");
    },
    async stop(): Promise<void> {
      await invoke("tunnel_stop");
    },
    async status(): Promise<string | null> {
      return invoke<string | null>("tunnel_status");
    },
    async install(): Promise<void> {
      await invoke("tunnel_install");
    },
    subscribeTunnelUrl(
      onUrl: (url: string) => void,
      onError: (err: string) => void,
    ): Unsubscribe {
      let cleanup: (() => void) | undefined;

      (async () => {
        const unlistenUrl = await listen<string>("tunnel-url", onUrl);
        const unlistenError = await listen<string>("tunnel-error", onError);

        cleanup = () => {
          unlistenUrl();
          unlistenError();
        };
      })();

      return () => cleanup?.();
    },
  };

  webserver = {
    async status(): Promise<boolean> {
      return invoke<boolean>("webserver_status");
    },
    async start(): Promise<void> {
      await invoke("webserver_start");
    },
    async stop(): Promise<void> {
      await invoke("webserver_stop");
    },
    async waitReady(): Promise<void> {
      await invoke("webserver_wait_ready");
    },
    async getToken(): Promise<string> {
      return invoke<string>("webserver_get_token");
    },
  };
}
