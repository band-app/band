import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { DashboardAdapter } from "../adapter";
import type {
  CIStatus,
  GitStatus,
  ProjectInfo,
  WorkspaceBranchStatus,
  WorkspaceStatus,
} from "../types";

export interface DashboardState {
  projects: ProjectInfo[];
  statuses: Map<string, WorkspaceStatus>;
  activeWorkspaceId: string | null;
  loading: boolean;
  error: string | null;
  branchStatuses: Map<string, WorkspaceBranchStatus>;

  loadProjects: () => Promise<void>;
  addProject: (path: string, label?: string) => Promise<void>;
  removeProject: (name: string) => Promise<void>;
  reorderProjects: (projectNames: string[]) => Promise<void>;
  createWorkspace: (
    project: string,
    branch: string,
    base?: string,
    prompt?: string,
  ) => Promise<void>;
  removeWorkspace: (project: string, branch: string) => Promise<void>;
  openWorkspace: (workspaceId: string) => void;
  clearError: () => void;
  updateStatus: (status: WorkspaceStatus) => void;
  removeStatus: (workspaceId: string) => void;
  setActiveWorkspace: (workspaceId: string | null) => void;
  runScript: (path: string, scriptType: string) => Promise<void>;
  updateProjectLabel: (project: string, label: string | null) => Promise<void>;
  updateGitStatus: (workspaceId: string, git: GitStatus) => void;
  updateCIStatus: (workspaceId: string, ci: CIStatus) => void;
}

export type DashboardStore = UseBoundStore<StoreApi<DashboardState>>;

export function createDashboardStore(adapter: DashboardAdapter): DashboardStore {
  return create<DashboardState>((set, get) => ({
    projects: [],
    statuses: new Map(),
    branchStatuses: new Map(),
    activeWorkspaceId: null,
    loading: false,
    error: null,

    loadProjects: async () => {
      set({ loading: true, error: null });
      try {
        const projects = await adapter.listProjects();
        set({ projects, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    addProject: async (path: string, label?: string) => {
      try {
        await adapter.addProject(path, label);
        await get().loadProjects();
      } catch (e) {
        set({ error: String(e) });
      }
    },

    removeProject: async (name: string) => {
      try {
        await adapter.removeProject(name);
        await get().loadProjects();
      } catch (e) {
        set({ error: String(e) });
      }
    },

    reorderProjects: async (projectNames: string[]) => {
      const previousProjects = get().projects;
      const reordered = [...previousProjects].sort(
        (a, b) => projectNames.indexOf(a.name) - projectNames.indexOf(b.name),
      );
      set({ projects: reordered });

      try {
        await adapter.reorderProjects(projectNames);
      } catch (e) {
        set({ projects: previousProjects, error: String(e) });
      }
    },

    createWorkspace: async (project: string, branch: string, base?: string, prompt?: string) => {
      try {
        await adapter.createWorkspace(project, branch, base, prompt);
      } catch (e) {
        set({ error: String(e) });
        return;
      }
      await get().loadProjects();
      const workspaceId = `${project}-${branch}`;
      get().openWorkspace(workspaceId);
    },

    removeWorkspace: async (project: string, branch: string) => {
      const previousProjects = get().projects;
      set({
        projects: previousProjects.map((p) =>
          p.name === project
            ? { ...p, worktrees: p.worktrees.filter((wt) => wt.branch !== branch) }
            : p,
        ),
      });

      try {
        await adapter.removeWorkspace(project, branch);
        await get().loadProjects();
      } catch (e) {
        set({ projects: previousProjects, error: String(e) });
      }
    },

    openWorkspace: (workspaceId: string) => {
      set({ activeWorkspaceId: workspaceId });
      adapter.openWorkspace(workspaceId).catch((e) => {
        set({ error: String(e) });
      });
    },

    clearError: () => set({ error: null }),

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
    },

    runScript: async (path: string, scriptType: string) => {
      try {
        await adapter.runScript(path, scriptType);
      } catch (e) {
        set({ error: String(e) });
      }
    },

    updateProjectLabel: async (project: string, label: string | null) => {
      try {
        await adapter.updateProjectLabel(project, label);
        await get().loadProjects();
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
