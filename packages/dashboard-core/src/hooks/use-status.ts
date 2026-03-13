import { useEffect, useRef } from "react";
import { useAdapter } from "../context";
import { playSound, type SoundId } from "../lib/sounds";
import { queryClient, queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { AgentStatusType, Settings } from "../types";

export function useStatusWatcher() {
  const adapter = useAdapter();
  const updateStatus = useDashboardStore((s) => s.updateStatus);
  const removeStatus = useDashboardStore((s) => s.removeStatus);
  const previousStatuses = useRef<Map<string, AgentStatusType>>(new Map());

  useEffect(() => {
    const unsubscribe = adapter.subscribeAgentStatus(
      (status) => {
        const wsId = status.workspaceId;
        const newAgentStatus = status.agent?.status;
        const prevAgentStatus = previousStatuses.current.get(wsId);

        if (newAgentStatus) {
          previousStatuses.current.set(wsId, newAgentStatus);
        } else {
          previousStatuses.current.delete(wsId);
        }

        if (prevAgentStatus === "working" && newAgentStatus === "needs_attention") {
          const settings = queryClient.getQueryData<Settings>(queryKeys.settings);
          const notifications = settings?.notifications;
          if (notifications?.soundOnNeedsAttention) {
            playSound((notifications.sound ?? "chime") as SoundId);
          }
        }

        updateStatus(status);
      },
      (workspaceId) => {
        previousStatuses.current.delete(workspaceId);
        removeStatus(workspaceId);
        adapter.closeWorkspaceWindows(workspaceId);
      },
    );

    return unsubscribe;
  }, [adapter, updateStatus, removeStatus]);
}

export function useActiveWorkspaceWatcher() {
  const adapter = useAdapter();
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);

  useEffect(() => {
    const unsubscribe = adapter.subscribeActiveWorkspace((workspaceId) => {
      setActiveWorkspace(workspaceId);
    });

    return unsubscribe;
  }, [adapter, setActiveWorkspace]);
}

export function useBranchStatusWatcher() {
  const adapter = useAdapter();
  const updateGitStatus = useDashboardStore((s) => s.updateGitStatus);
  const updateCIStatus = useDashboardStore((s) => s.updateCIStatus);

  useEffect(() => {
    const unsubscribe = adapter.subscribeBranchStatus(
      (workspaceId, git) => {
        updateGitStatus(workspaceId, git);
      },
      (workspaceId, ci) => {
        updateCIStatus(workspaceId, ci);
      },
    );

    return unsubscribe;
  }, [adapter, updateGitStatus, updateCIStatus]);
}
