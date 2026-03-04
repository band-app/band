import { useEffect, useRef } from "react";
import { useDashboardStore, WorkspaceStatus, AgentStatusType, GitStatus, CIStatus } from "@/stores/dashboard-store";
import { useSettingsStore } from "@/stores/settings-store";
import { playSound, type SoundId } from "@/lib/sounds";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface StatusEvent {
  kind: "update" | "remove";
  status?: WorkspaceStatus;
  workspaceId?: string;
}

export function useStatusWatcher() {
  const updateStatus = useDashboardStore((s) => s.updateStatus);
  const removeStatus = useDashboardStore((s) => s.removeStatus);
  const previousStatuses = useRef<Map<string, AgentStatusType>>(new Map());

  useEffect(() => {
    if (!isTauri()) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      invoke("status_watch_start").catch(console.error);

      const unlisten = await listen<StatusEvent>("agent-status", (event) => {
        const payload = event.payload;
        if (payload.kind === "update" && payload.status) {
          const wsId = payload.status.workspaceId;
          const newAgentStatus = payload.status.agent?.status;
          const prevAgentStatus = previousStatuses.current.get(wsId);

          if (newAgentStatus) {
            previousStatuses.current.set(wsId, newAgentStatus);
          } else {
            previousStatuses.current.delete(wsId);
          }

          if (
            prevAgentStatus === "working" &&
            newAgentStatus === "needs_attention"
          ) {
            const notifications =
              useSettingsStore.getState().settings.notifications;
            if (notifications?.soundOnNeedsAttention) {
              playSound((notifications.sound ?? "chime") as SoundId);
            }
          }

          updateStatus(payload.status);
        } else if (payload.kind === "remove" && payload.workspaceId) {
          previousStatuses.current.delete(payload.workspaceId);
          removeStatus(payload.workspaceId);
        }
      });

      cleanup = () => {
        unlisten();
        invoke("status_watch_stop").catch(console.error);
      };
    })();

    return () => cleanup?.();
  }, [updateStatus, removeStatus]);
}

export function useActiveWorkspaceWatcher() {
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);

  useEffect(() => {
    if (!isTauri()) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      // Read current value on startup
      try {
        const wsId = await invoke<string | null>("get_active_workspace");
        setActiveWorkspace(wsId);
      } catch {
        // ignore
      }

      // Listen for file watcher events on active.json
      const unlisten = await listen<string>("active-workspace", (event) => {
        console.log("[dashboard] active-workspace event from Rust:", event.payload);
        setActiveWorkspace(event.payload);
      });

      cleanup = unlisten;
    })();

    return () => cleanup?.();
  }, [setActiveWorkspace]);
}

interface GitStatusEvent {
  workspace_id: string;
  git: GitStatus;
}

interface CIStatusEvent {
  workspace_id: string;
  ci: CIStatus;
}

export function useBranchStatusWatcher() {
  const updateGitStatus = useDashboardStore((s) => s.updateGitStatus);
  const updateCIStatus = useDashboardStore((s) => s.updateCIStatus);

  useEffect(() => {
    if (!isTauri()) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      invoke("branch_status_watch_start").catch(console.error);

      const unlistenGit = await listen<GitStatusEvent>("branch-git-status", (event) => {
        updateGitStatus(event.payload.workspace_id, event.payload.git);
      });

      const unlistenCI = await listen<CIStatusEvent>("branch-ci-status", (event) => {
        updateCIStatus(event.payload.workspace_id, event.payload.ci);
      });

      cleanup = () => {
        unlistenGit();
        unlistenCI();
        invoke("branch_status_watch_stop").catch(console.error);
      };
    })();

    return () => cleanup?.();
  }, [updateGitStatus, updateCIStatus]);
}
