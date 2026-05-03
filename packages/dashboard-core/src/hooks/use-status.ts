import { useEffect, useRef } from "react";
import { useAdapter } from "../context";
import { playSound, type SoundId } from "../lib/sounds";
import type { SSEEvent } from "../lib/sse";
import { queryClient, queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { AgentStatusType, Settings } from "../types";

export function useStatusWatcher() {
  const adapter = useAdapter();
  const replaceAllStatuses = useDashboardStore((s) => s.replaceAllStatuses);
  const updateStatus = useDashboardStore((s) => s.updateStatus);
  const removeStatus = useDashboardStore((s) => s.removeStatus);
  const previousStatuses = useRef<Map<string, AgentStatusType>>(new Map());

  useEffect(() => {
    const unsubscribe = adapter.subscribeAgentStatus(
      (statuses) => {
        replaceAllStatuses(statuses);
        // Rebuild previous statuses tracking from snapshot
        previousStatuses.current.clear();
        for (const status of statuses) {
          if (status.agent?.status) {
            previousStatuses.current.set(status.workspaceId, status.agent.status);
          }
        }
      },
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
      },
    );

    return unsubscribe;
  }, [adapter, replaceAllStatuses, updateStatus, removeStatus]);
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

export function useSetupStatusWatcher() {
  const adapter = useAdapter();
  const updateSetupStatus = useDashboardStore((s) => s.updateSetupStatus);
  const removeSetupStatus = useDashboardStore((s) => s.removeSetupStatus);
  const reconcileSetupStatuses = useDashboardStore((s) => s.reconcileSetupStatuses);

  useEffect(() => {
    const unsubscribe = adapter.subscribeStatusEvents((event) => {
      const data = event as SSEEvent;

      if (data.kind === "snapshot" && data.runningSetups) {
        reconcileSetupStatuses(data.runningSetups);
        return;
      }

      if (data.kind !== "setup-status" || !data.workspaceId) return;

      if (data.setupState === "running") {
        updateSetupStatus(data.workspaceId, { state: "running" });
      } else if (data.setupState === "completed") {
        removeSetupStatus(data.workspaceId);
      } else if (data.setupState === "failed") {
        updateSetupStatus(data.workspaceId, {
          state: "failed",
          error: data.setupError,
        });
      }
    });

    return unsubscribe;
  }, [adapter, updateSetupStatus, removeSetupStatus, reconcileSetupStatuses]);
}
