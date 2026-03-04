import { useEffect } from "react";
import { useDashboardStore, WorkspaceStatus, WorkspaceBranchStatus } from "@/stores/dashboard-store";

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
          updateStatus(payload.status);
        } else if (payload.kind === "remove" && payload.workspaceId) {
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

interface BranchStatusEvent {
  statuses: Record<string, WorkspaceBranchStatus>;
}

export function useBranchStatusWatcher() {
  const updateBranchStatuses = useDashboardStore((s) => s.updateBranchStatuses);

  useEffect(() => {
    if (!isTauri()) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      invoke("branch_status_watch_start").catch(console.error);

      const unlisten = await listen<BranchStatusEvent>("branch-status", (event) => {
        updateBranchStatuses(event.payload.statuses);
      });

      cleanup = () => {
        unlisten();
        invoke("branch_status_watch_stop").catch(console.error);
      };
    })();

    return () => cleanup?.();
  }, [updateBranchStatuses]);
}
