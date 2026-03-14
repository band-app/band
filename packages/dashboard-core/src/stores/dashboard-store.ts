import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { DashboardAdapter } from "../adapter";
import type { CIStatus, GitStatus, WorkspaceBranchStatus, WorkspaceStatus } from "../types";

export interface DashboardState {
  statuses: Map<string, WorkspaceStatus>;
  activeWorkspaceId: string | null;
  error: string | null;
  branchStatuses: Map<string, WorkspaceBranchStatus>;
  _openingWorkspace: boolean;

  openWorkspace: (workspaceId: string) => void;
  clearError: () => void;
  setError: (error: string) => void;
  updateStatus: (status: WorkspaceStatus) => void;
  removeStatus: (workspaceId: string) => void;
  setActiveWorkspace: (workspaceId: string | null) => void;
  runScript: (path: string, scriptType: string) => Promise<void>;
  updateGitStatus: (workspaceId: string, git: GitStatus) => void;
  updateCIStatus: (workspaceId: string, ci: CIStatus) => void;
}

export type DashboardStore = UseBoundStore<StoreApi<DashboardState>>;

export function createDashboardStore(adapter: DashboardAdapter): DashboardStore {
  return create<DashboardState>((set, get) => ({
    statuses: new Map(),
    branchStatuses: new Map(),
    activeWorkspaceId: null,
    error: null,
    _openingWorkspace: false,

    openWorkspace: (workspaceId: string) => {
      // Block duplicate clicks on the same workspace while it's opening,
      // but allow switching to a different workspace.
      if (get()._openingWorkspace && get().activeWorkspaceId === workspaceId) return;
      set({ activeWorkspaceId: workspaceId, _openingWorkspace: true });
      adapter
        .openWorkspace(workspaceId)
        .catch((e) => {
          set({ error: String(e) });
        })
        .finally(() => {
          // Delay clearing the flag so focus-polling events that arrive
          // before the new windows are fully raised get ignored.  The
          // Rust side also suppresses detection, but this provides
          // defense in depth on the JS side.
          setTimeout(() => {
            // Only clear if this workspace is still the one being opened
            // (a newer openWorkspace call may have overridden it).
            if (get().activeWorkspaceId === workspaceId) {
              set({ _openingWorkspace: false });
            }
          }, 2000);
        });
    },

    clearError: () => set({ error: null }),

    setError: (error: string) => set({ error }),

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
      // While a user-initiated openWorkspace() is in progress, ignore external
      // active-workspace events (e.g. from Tauri focus polling). The polling
      // can briefly report the *old* workspace as frontmost before the new IDE
      // window actually appears, which would revert the user's selection.
      if (get()._openingWorkspace) return;
      if (get().activeWorkspaceId === workspaceId) return;
      set({ activeWorkspaceId: workspaceId });
    },

    runScript: async (path: string, scriptType: string) => {
      try {
        await adapter.runScript(path, scriptType);
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
  }));
}
