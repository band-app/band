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
  const setDeleting = useDashboardStore((s) => s.setDeleting);
  const previousStatuses = useRef<Map<string, AgentStatusType>>(new Map());

  useEffect(() => {
    const unsubscribe = adapter.subscribeAgentStatus(
      (statuses) => {
        replaceAllStatuses(statuses);
        // Rebuild previous statuses tracking from snapshot
        previousStatuses.current.clear();
        for (const status of statuses) {
          if (status.agent?.status) {
            previousStatuses.current.set(status.worktreeId, status.agent.status);
          }
        }
      },
      (status) => {
        const wsId = status.worktreeId;
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
      (worktreeId) => {
        previousStatuses.current.delete(worktreeId);
        removeStatus(worktreeId);
        // A removal started elsewhere (the CLI, another window) would
        // otherwise leave the card listed until the next repos poll.
        // Keep it marked as deleting until the refetch drops it.
        setDeleting(worktreeId, true);
        void queryClient
          .invalidateQueries({ queryKey: queryKeys.repos })
          .finally(() => setDeleting(worktreeId, false));
      },
    );

    return unsubscribe;
  }, [adapter, replaceAllStatuses, updateStatus, removeStatus, setDeleting]);
}

export function useBranchStatusWatcher() {
  const adapter = useAdapter();
  const updateGitStatus = useDashboardStore((s) => s.updateGitStatus);
  const updateCIStatus = useDashboardStore((s) => s.updateCIStatus);

  useEffect(() => {
    const unsubscribe = adapter.subscribeBranchStatus(
      (worktreeId, git) => {
        updateGitStatus(worktreeId, git);
      },
      (worktreeId, ci) => {
        updateCIStatus(worktreeId, ci);
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

      if (data.kind !== "setup-status" || !data.worktreeId) return;

      const script = data.script ?? "setup";
      if (data.setupState === "running") {
        updateSetupStatus(data.worktreeId, { state: "running", script });
      } else if (data.setupState === "completed") {
        removeSetupStatus(data.worktreeId);
      } else if (data.setupState === "failed") {
        updateSetupStatus(data.worktreeId, {
          state: "failed",
          script,
          error: data.setupError,
        });
      }
    });

    return unsubscribe;
  }, [adapter, updateSetupStatus, removeSetupStatus, reconcileSetupStatuses]);
}
