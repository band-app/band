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
  /** Workspaces this dashboard asked the server to remove, until the removal settles. */
  deletingWorkspaces: ReadonlySet<string>;

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
  setDeleting: (workspaceId: string, deleting: boolean) => void;
}

export type DashboardStore = UseBoundStore<StoreApi<DashboardState>>;

/**
 * Whether a workspace is being deleted: from the moment this dashboard sends
 * the removal, or while the server runs its teardown (which also covers a
 * removal started from the CLI or another window).
 */
export function isWorkspaceDeleting(
  state: Pick<DashboardState, "deletingWorkspaces" | "setupStatuses">,
  workspaceId: string,
): boolean {
  if (state.deletingWorkspaces.has(workspaceId)) return true;
  const setup = state.setupStatuses.get(workspaceId);
  return setup?.script === "teardown" && setup.state === "running";
}

export function createDashboardStore(adapter: DashboardAdapter): DashboardStore {
  return create<DashboardState>((set, get) => ({
    statuses: new Map(),
    branchStatuses: new Map(),
    setupStatuses: new Map(),
    deletingWorkspaces: new Set(),
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
        // The workspace is gone, so its teardown status goes with it. A new
        // workspace created under the same name must not start as deleting.
        if (!state.setupStatuses.has(workspaceId)) return { statuses };
        const setupStatuses = new Map(state.setupStatuses);
        setupStatuses.delete(workspaceId);
        return { statuses, setupStatuses };
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

    setDeleting: (workspaceId: string, deleting: boolean) => {
      set((state) => {
        if (state.deletingWorkspaces.has(workspaceId) === deleting) return state;
        const deletingWorkspaces = new Set(state.deletingWorkspaces);
        if (deleting) deletingWorkspaces.add(workspaceId);
        else deletingWorkspaces.delete(workspaceId);
        return { deletingWorkspaces };
      });
    },
  }));
}
