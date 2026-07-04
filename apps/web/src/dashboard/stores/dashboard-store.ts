import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { DashboardAdapter } from "../adapter";
import type {
  CIStatus,
  GitStatus,
  SetupStatus,
  WorkspaceBranchStatus,
  WorkspaceStatus,
} from "../types";

export interface DashboardState {
  statuses: Map<string, WorkspaceStatus>;
  activeWorkspaceId: string | null;
  error: string | null;
  branchStatuses: Map<string, WorkspaceBranchStatus>;
  setupStatuses: Map<string, SetupStatus>;

  openWorkspace: (workspaceId: string) => void;
  clearNeedsAttention: (workspaceId: string) => void;
  clearError: () => void;
  setError: (error: string) => void;
  replaceAllStatuses: (statuses: WorkspaceStatus[]) => void;
  updateStatus: (status: WorkspaceStatus) => void;
  removeStatus: (workspaceId: string) => void;
  setActiveWorkspace: (workspaceId: string | null) => void;
  runScript: (path: string, scriptType: string) => Promise<void>;
  gitPull: (project: string, name: string) => Promise<void>;
  gitPush: (project: string, name: string) => Promise<void>;
  updateGitStatus: (workspaceId: string, git: GitStatus) => void;
  updateCIStatus: (workspaceId: string, ci: CIStatus) => void;
  updateSetupStatus: (workspaceId: string, status: SetupStatus) => void;
  removeSetupStatus: (workspaceId: string) => void;
  reconcileSetupStatuses: (runningSetups: string[]) => void;
}

export type DashboardStore = UseBoundStore<StoreApi<DashboardState>>;

export function createDashboardStore(adapter: DashboardAdapter): DashboardStore {
  return create<DashboardState>((set, get) => ({
    statuses: new Map(),
    branchStatuses: new Map(),
    setupStatuses: new Map(),
    activeWorkspaceId: null,
    error: null,

    openWorkspace: (workspaceId: string) => {
      set({ activeWorkspaceId: workspaceId });
      get().clearNeedsAttention(workspaceId);
    },

    clearNeedsAttention: (workspaceId: string) => {
      adapter.clearNeedsAttention?.(workspaceId).catch(() => {});
    },

    clearError: () => set({ error: null }),

    setError: (error: string) => set({ error }),

    replaceAllStatuses: (list: WorkspaceStatus[]) => {
      const statuses = new Map(list.map((s) => [s.workspaceId, s]));
      set({ statuses });
    },

    updateStatus: (status: WorkspaceStatus) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        statuses.set(status.workspaceId, status);
        return { statuses };
      });
    },

    removeStatus: (workspaceId: string) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        statuses.delete(workspaceId);
        return { statuses };
      });
    },

    setActiveWorkspace: (workspaceId: string | null) => {
      if (get().activeWorkspaceId === workspaceId) return;
      set({ activeWorkspaceId: workspaceId });
      // When the user navigates to a workspace, clear any pending
      // needs-attention indicator — they're now looking at it.
      if (workspaceId) {
        get().clearNeedsAttention(workspaceId);
      }
    },

    runScript: async (path: string, scriptType: string) => {
      try {
        await adapter.runScript(path, scriptType);
      } catch (e) {
        set({ error: String(e) });
      }
    },

    gitPull: async (project: string, name: string) => {
      try {
        await adapter.gitPull(project, name);
      } catch (e) {
        set({ error: String(e) });
      }
    },

    gitPush: async (project: string, name: string) => {
      try {
        await adapter.gitPush(project, name);
      } catch (e) {
        set({ error: String(e) });
      }
    },

    updateGitStatus: (workspaceId: string, git: GitStatus) => {
      set((state) => {
        const branchStatuses = new Map(state.branchStatuses);
        const existing = branchStatuses.get(workspaceId);
        branchStatuses.set(workspaceId, {
          git,
          ci: existing?.ci ?? { state: "none" },
        });
        return { branchStatuses };
      });
    },

    updateCIStatus: (workspaceId: string, ci: CIStatus) => {
      set((state) => {
        const branchStatuses = new Map(state.branchStatuses);
        const existing = branchStatuses.get(workspaceId);
        branchStatuses.set(workspaceId, {
          git: existing?.git ?? {
            dirty: false,
            conflict: false,
            ahead: 0,
            behind: 0,
            sync_state: "synced",
          },
          ci,
        });
        return { branchStatuses };
      });
    },

    updateSetupStatus: (workspaceId: string, status: SetupStatus) => {
      set((state) => {
        const setupStatuses = new Map(state.setupStatuses);
        setupStatuses.set(workspaceId, status);
        return { setupStatuses };
      });
    },

    removeSetupStatus: (workspaceId: string) => {
      set((state) => {
        const setupStatuses = new Map(state.setupStatuses);
        setupStatuses.delete(workspaceId);
        return { setupStatuses };
      });
    },

    reconcileSetupStatuses: (runningSetups: string[]) => {
      set((state) => {
        const runningSet = new Set(runningSetups);
        let changed = false;
        const setupStatuses = new Map(state.setupStatuses);
        for (const [id, status] of setupStatuses) {
          if (status.state === "running" && !runningSet.has(id)) {
            setupStatuses.delete(id);
            changed = true;
          }
        }
        return changed ? { setupStatuses } : state;
      });
    },
  }));
}
